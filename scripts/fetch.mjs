#!/usr/bin/env node
// Standalone, zero-dependency fetcher for the open-fedspend-data dataset.
//
// Pulls US federal prime contract awards from USAspending.gov's public
// spending_by_award search API (no API key, no auth) for a rolling recent
// window, normalizes them into one schema, and writes data/awards.json,
// data/awards.csv, three aggregate files, and data/summary.json.
//
// This is intentionally narrow: contracts only (no grants), one fixed
// window, no arbitrary filters at request time. For custom NAICS/agency/
// recipient/date-range queries run on demand, see the paid Apify actor
// linked in the README.

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const USASPENDING_URL = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';

// Rolling window: last 7 days (inclusive of today, UTC). Chosen because a
// 30-day window of ALL federal prime contracts routinely runs into
// USAspending's 50,000-row simple-pagination cap (verified live: a 7-day
// window of contract awards across every agency runs ~9,000-10,000 rows,
// comfortably under the cap; a 30-day window would not be). See README
// "Limitations" for the cap itself.
const WINDOW_DAYS = 7;

// Contract award type codes: A=BPA Call, B=Purchase Order, C=Delivery Order,
// D=Definitive Contract. (Grant/assistance codes 02/03/04/05 are out of
// scope for this repo — contracts only.)
const AWARD_TYPE_CODES = ['A', 'B', 'C', 'D'];

// USAspending's `fields` array is not validated against a single fixed
// schema, but the `sort` field must appear in `fields` or the request
// errors, and requesting a field the award-type category doesn't support
// just returns null rather than erroring. This exact field list was
// confirmed live against the contracts category before shipping.
const REQUEST_FIELDS = [
  'Award ID',
  'Recipient Name',
  'Recipient UEI',
  'Award Amount',
  'Total Outlays',
  'Awarding Agency',
  'Awarding Sub Agency',
  'Award Type',
  'Contract Award Type',
  'Description',
  'Start Date',
  'End Date',
  'Last Modified Date',
  'naics_code',
  'naics_description',
  'psc_code',
  'psc_description',
  'pop_state_code',
  'pop_country_name',
  'generated_internal_id',
];

const PAGE_LIMIT = 100; // USAspending's hard per-page cap for this endpoint.
// USAspending caps simple page-number pagination at page*limit <= 50,000.
// Stay comfortably under that so a heavier-than-usual week doesn't 400.
const MAX_PAGEABLE_RESULTS = 49900;
const REQUEST_DELAY_MS = 150;
const MAX_RETRIES = 4;
const RETRY_BASE_MS = 750;
const FETCH_TIMEOUT_MS = 30000;
const USER_AGENT = 'open-fedspend-data/1.0 (+https://github.com/) polite-bot';
const TOP_N = 100; // how many rows to keep in each ranked aggregate file

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function postJsonWithRetry(url, body) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} (non-retryable): ${text.slice(0, 300)}`);
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`Bad JSON response: ${text.slice(0, 300)}`);
      }
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err;
      const nonRetryable = err instanceof Error && err.message.includes('non-retryable');
      if (nonRetryable) throw err;
      if (attempt < MAX_RETRIES) {
        const backoff = RETRY_BASE_MS * 2 ** attempt + Math.random() * 300;
        console.log(`  retry ${attempt + 1}/${MAX_RETRIES} after error: ${err.message} (waiting ${Math.round(backoff)}ms)`);
        await sleep(backoff);
        continue;
      }
    }
  }
  throw lastErr ?? new Error('fetch failed');
}

// ---------------------------------------------------------------------------
// USAspending fetch + normalize
// ---------------------------------------------------------------------------

function buildFilters(startDate, endDate) {
  return {
    award_type_codes: AWARD_TYPE_CODES,
    time_period: [{ start_date: startDate, end_date: endDate }],
  };
}

async function fetchAllAwards(startDate, endDate) {
  const filters = buildFilters(startDate, endDate);
  const results = [];
  let page = 1;
  let hasNext = true;

  while (hasNext) {
    if (page * PAGE_LIMIT > MAX_PAGEABLE_RESULTS) {
      console.log(`  hit pagination safety cap (${MAX_PAGEABLE_RESULTS} rows) at page ${page}; stopping early.`);
      break;
    }
    const body = {
      filters,
      fields: REQUEST_FIELDS,
      sort: 'Award Amount',
      order: 'desc',
      page,
      limit: PAGE_LIMIT,
    };

    let response;
    try {
      response = await postJsonWithRetry(USASPENDING_URL, body);
    } catch (err) {
      // Never let one bad page kill the whole run — log and stop paging,
      // keep whatever was collected so far.
      console.error(`  page ${page} failed after retries: ${err.message}. Stopping pagination, keeping ${results.length} rows collected so far.`);
      break;
    }

    const pageResults = response.results ?? [];
    results.push(...pageResults);
    // NOTE: USAspending's page_metadata.hasNext is unreliable for this
    // endpoint when sorted by Award Amount — verified live that it reports
    // `false` starting around page 100 while full pages of 100 results kept
    // coming back through page ~280. So the real end-of-results signal used
    // here is a short/empty page, not the hasNext flag.
    hasNext = pageResults.length === PAGE_LIMIT;

    if (page % 10 === 0 || !hasNext) {
      console.log(`  page ${page}: +${pageResults.length} rows (total ${results.length}), pageFull=${hasNext}`);
    }

    page += 1;
    if (hasNext) await sleep(REQUEST_DELAY_MS);
  }

  return results;
}

function normalizeAward(raw, scrapedAt) {
  return {
    awardId: raw['Award ID'] ?? null,
    recipientName: raw['Recipient Name'] ?? null,
    recipientUei: raw['Recipient UEI'] ?? null,
    awardingAgency: raw['Awarding Agency'] ?? null,
    awardingSubAgency: raw['Awarding Sub Agency'] ?? null,
    awardAmount: raw['Award Amount'] ?? null,
    totalOutlays: raw['Total Outlays'] ?? null,
    awardType: raw['Contract Award Type'] ?? raw['Award Type'] ?? null,
    naicsCode: raw.naics_code ?? null,
    naicsDescription: raw.naics_description ?? null,
    pscCode: raw.psc_code ?? null,
    pscDescription: raw.psc_description ?? null,
    placeOfPerformanceState: raw.pop_state_code ?? null,
    placeOfPerformanceCountry: raw.pop_country_name ?? null,
    startDate: raw['Start Date'] ?? null,
    endDate: raw['End Date'] ?? null,
    description: raw.Description ?? null,
    usaspendingUrl: raw.generated_internal_id
      ? `https://www.usaspending.gov/award/${encodeURIComponent(raw.generated_internal_id)}`
      : null,
    scrapedAt,
  };
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

function buildTopRecipients(awards) {
  const byRecipient = new Map();
  for (const a of awards) {
    if (!a.recipientName) continue;
    const key = a.recipientName;
    const entry = byRecipient.get(key) ?? { recipientName: key, recipientUei: a.recipientUei ?? null, totalObligated: 0, awardCount: 0 };
    entry.totalObligated += a.awardAmount ?? 0;
    entry.awardCount += 1;
    if (!entry.recipientUei && a.recipientUei) entry.recipientUei = a.recipientUei;
    byRecipient.set(key, entry);
  }
  return [...byRecipient.values()]
    .sort((a, b) => b.totalObligated - a.totalObligated)
    .slice(0, TOP_N)
    .map((e) => ({ ...e, totalObligated: Math.round(e.totalObligated * 100) / 100 }));
}

function buildByAgency(awards) {
  const byAgency = new Map();
  for (const a of awards) {
    const key = a.awardingAgency ?? 'UNKNOWN';
    const entry = byAgency.get(key) ?? { awardingAgency: a.awardingAgency ?? null, totalObligated: 0, awardCount: 0 };
    entry.totalObligated += a.awardAmount ?? 0;
    entry.awardCount += 1;
    byAgency.set(key, entry);
  }
  return [...byAgency.values()]
    .sort((a, b) => b.totalObligated - a.totalObligated)
    .map((e) => ({ ...e, totalObligated: Math.round(e.totalObligated * 100) / 100 }));
}

function buildByNaics(awards) {
  const byNaics = new Map();
  for (const a of awards) {
    if (!a.naicsCode) continue;
    const key = a.naicsCode;
    const entry = byNaics.get(key) ?? { naicsCode: a.naicsCode, naicsDescription: a.naicsDescription ?? null, totalObligated: 0, awardCount: 0 };
    entry.totalObligated += a.awardAmount ?? 0;
    entry.awardCount += 1;
    if (!entry.naicsDescription && a.naicsDescription) entry.naicsDescription = a.naicsDescription;
    byNaics.set(key, entry);
  }
  return [...byNaics.values()]
    .sort((a, b) => b.totalObligated - a.totalObligated)
    .map((e) => ({ ...e, totalObligated: Math.round(e.totalObligated * 100) / 100 }));
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const CSV_HEADERS = [
  'awardId', 'recipientName', 'recipientUei', 'awardingAgency', 'awardingSubAgency',
  'awardAmount', 'totalOutlays', 'awardType', 'naicsCode', 'naicsDescription',
  'pscCode', 'pscDescription', 'placeOfPerformanceState', 'placeOfPerformanceCountry',
  'startDate', 'endDate', 'description', 'usaspendingUrl', 'scrapedAt',
];

function toCsv(rows) {
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [CSV_HEADERS.join(',')];
  for (const row of rows) {
    lines.push(CSV_HEADERS.map((h) => escape(row[h])).join(','));
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = Date.now();
  const scrapedAt = nowIso();

  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (WINDOW_DAYS - 1));
  const startDate = isoDate(start);
  const endDate = isoDate(end);

  console.log(`Fetching US federal contract awards, ${startDate}..${endDate} (${WINDOW_DAYS}-day window)...`);

  const rawResults = await fetchAllAwards(startDate, endDate);
  console.log(`Fetched ${rawResults.length} raw rows.`);

  const awards = rawResults.map((r) => normalizeAward(r, scrapedAt));

  const topRecipients = buildTopRecipients(awards);
  const byAgency = buildByAgency(awards);
  const byNaics = buildByNaics(awards);

  const totalObligated = awards.reduce((sum, a) => sum + (a.awardAmount ?? 0), 0);
  const totalOutlays = awards.reduce((sum, a) => sum + (a.totalOutlays ?? 0), 0);
  const elapsedMs = Date.now() - startedAt;

  const hitPaginationCap = rawResults.length >= MAX_PAGEABLE_RESULTS - PAGE_LIMIT;

  const summary = {
    generatedAt: scrapedAt,
    window: { startDate, endDate, days: WINDOW_DAYS },
    totalAwards: awards.length,
    totalObligated: Math.round(totalObligated * 100) / 100,
    totalOutlays: Math.round(totalOutlays * 100) / 100,
    uniqueRecipients: topRecipients.length ? new Set(awards.map((a) => a.recipientName).filter(Boolean)).size : 0,
    uniqueAgencies: byAgency.length,
    hitPaginationCap,
    source: 'https://api.usaspending.gov/api/v2/search/spending_by_award/',
    elapsedMs,
    notes: [
      'awardAmount is the obligated amount for this award transaction (USAspending "Award Amount"), not a contract ceiling/potential value.',
      'totalOutlays is USAspending "Total Outlays" — actual dollars disbursed to date against the award, where reported; null when not reported. It is NOT a ceiling or ask price.',
      'A single row can represent a large multi-year vehicle; the dates shown are that award transaction\'s period of performance, not necessarily when money changed hands in this window.',
      hitPaginationCap
        ? 'This run hit the pagination safety cap — the dataset contains the largest awards by awardAmount in the window, not a complete set. See data/README.md.'
        : 'This run completed pagination without hitting the safety cap — the dataset is the complete set of matching awards for the window.',
    ],
  };

  await mkdir(path.join(ROOT, 'data'), { recursive: true });

  await writeFile(path.join(ROOT, 'data', 'awards.json'), JSON.stringify(awards, null, 2) + '\n');
  await writeFile(path.join(ROOT, 'data', 'awards.csv'), toCsv(awards));
  await writeFile(path.join(ROOT, 'data', 'top-recipients.json'), JSON.stringify(topRecipients, null, 2) + '\n');
  await writeFile(path.join(ROOT, 'data', 'by-agency.json'), JSON.stringify(byAgency, null, 2) + '\n');
  await writeFile(path.join(ROOT, 'data', 'by-naics.json'), JSON.stringify(byNaics, null, 2) + '\n');
  await writeFile(path.join(ROOT, 'data', 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

  console.log(`Done in ${(elapsedMs / 1000).toFixed(1)}s.`);
  console.log(`Total awards: ${awards.length}`);
  console.log(`Total obligated: $${summary.totalObligated.toLocaleString()}`);
  console.log(`Top 3 recipients by obligated:`, topRecipients.slice(0, 3).map((r) => `${r.recipientName} ($${r.totalObligated.toLocaleString()})`));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
