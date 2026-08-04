# open-fedspend-data

A free, daily-updated dataset of US federal contract awards, pulled directly
from USAspending.gov's public search API and normalized into one schema.

Current snapshot: **28,092 contract awards**, window **2026-07-29 to
2026-08-04** (rolling 7 days), totaling **$436,328,109,541.33 obligated**
(last full run: 2026-08-04, ~135s). Numbers move daily as the window rolls
forward — see `data/summary.json` for the current window and totals.

Data lives in [`data/`](data/):

- [`data/awards.json`](data/awards.json) — every award in the window, as JSON
- [`data/awards.csv`](data/awards.csv) — same data as CSV
- [`data/top-recipients.json`](data/top-recipients.json) — recipients ranked by total obligated in the window
- [`data/by-agency.json`](data/by-agency.json) — totals by awarding agency
- [`data/by-naics.json`](data/by-naics.json) — totals by NAICS industry code
- [`data/summary.json`](data/summary.json) — window dates, totals, run stats
- [`data/README.md`](data/README.md) — full schema doc and what the money fields mean

A GitHub Actions workflow (`.github/workflows/update.yml`) re-runs the
fetcher every day and commits whatever changed. No manual updates.

## Why this exists

USAspending.gov publishes every federal prime contract award since FY2008
through a public, unauthenticated JSON search API — no key, no login, no rate
limit registration. It's the same API that powers usaspending.gov's own
search page. This repo fetches a rolling recent window of contract awards
daily, normalizes it, computes a few useful aggregates, and commits it, so
you don't have to write your own pagination/retry logic against the raw API
to get a clean CSV.

## The window

**Rolling 7 days**, recalculated on every run: today back through 6 days ago
(UTC, inclusive). Not a fixed calendar range — it shifts forward one day each
time the fetcher runs. 7 days, not 30, because a 30-day window of every
federal contract routinely runs past what USAspending's search endpoint can
reliably paginate through in one run (see Limitations). A week of contract
awards across every US federal agency is `~25,000-30,000` rows — substantial,
but a single fetch completes in a couple of minutes.

## Schema

| Field | Type | Notes |
|---|---|---|
| `awardId` | string \| null | USAspending's Award ID (piid/fain) |
| `recipientName` | string \| null | Vendor/recipient legal name |
| `recipientUei` | string \| null | Recipient's Unique Entity Identifier, when disclosed |
| `awardingAgency` | string \| null | Top-tier awarding agency |
| `awardingSubAgency` | string \| null | Sub-agency/component |
| `awardAmount` | number \| null | Obligated amount for this award transaction — not a ceiling/potential value, see below |
| `totalOutlays` | number \| null | Actual dollars disbursed to date, where reported |
| `awardType` | string \| null | e.g. "DEFINITIVE CONTRACT", "PURCHASE ORDER" |
| `naicsCode` / `naicsDescription` | string \| null | Industry classification |
| `pscCode` / `pscDescription` | string \| null | Product/Service Code |
| `placeOfPerformanceState` / `placeOfPerformanceCountry` | string \| null | Where the work is performed |
| `startDate` / `endDate` | string \| null | Award's period of performance |
| `description` | string \| null | USAspending's award description, as published |
| `usaspendingUrl` | string \| null | Direct link to the award's public page on usaspending.gov |
| `scrapedAt` | string | ISO timestamp of the fetch that produced this row |

Fields USAspending doesn't disclose come back as JSON `null`, never `0` or
`false`.

### Sample rows (from the live run above, verified against usaspending.gov)

A large multi-year vehicle:

```json
{
  "awardId": "DENA0003525",
  "recipientName": "NATIONAL TECHNOLOGY & ENGINEERING SOLUTIONS OF SANDIA, LLC",
  "recipientUei": "LUJEPCRRT377",
  "awardingAgency": "Department of Energy",
  "awardingSubAgency": "Department of Energy",
  "awardAmount": 42774168231.25,
  "totalOutlays": 26301056802.91,
  "awardType": "DEFINITIVE CONTRACT",
  "naicsCode": "561210",
  "naicsDescription": "FACILITIES SUPPORT SERVICES",
  "pscCode": "M1JZ",
  "pscDescription": "OPERATION OF MISCELLANEOUS BUILDINGS",
  "placeOfPerformanceState": "NM",
  "placeOfPerformanceCountry": "UNITED STATES",
  "startDate": "2017-01-18",
  "endDate": "2027-04-30",
  "description": "IGF::CL,CT::IGF CONTRACT AWARD DE-NA0003525 TO THE NATIONAL TECHNOLOGY&ENGINEERING SOLUTIONS OF SANDIA, LLC (NTESS) FOR THE MANAGEMENT AND OPERATION OF THE DEPARTMENT OF ENERGY, NATIONAL NUCLEAR SECURITY ADMINISTRATION'S SANDIA NATIONAL LABORATORIES (SNL)",
  "usaspendingUrl": "https://www.usaspending.gov/award/CONT_AWD_DENA0003525_8900_-NONE-_-NONE-",
  "scrapedAt": "2026-08-04T04:56:47.702Z"
}
```

A more typical, smaller award (most rows in the dataset look like this, not
the one above):

```json
{
  "awardId": "140P4226P0018",
  "recipientName": "CARAHSOFT TECHNOLOGY CORP",
  "recipientUei": "DT8KJHZXVJH5",
  "awardingAgency": "Department of the Interior",
  "awardingSubAgency": "National Park Service",
  "awardAmount": 181429.52,
  "totalOutlays": null,
  "awardType": "PURCHASE ORDER",
  "naicsCode": "334310",
  "naicsDescription": "AUDIO AND VIDEO EQUIPMENT MANUFACTURING",
  "pscCode": "5836",
  "pscDescription": "VIDEO RECORDING AND REPRODUCING EQUIPMENT",
  "placeOfPerformanceState": "VA",
  "placeOfPerformanceCountry": "UNITED STATES",
  "startDate": "2026-07-28",
  "endDate": "2031-08-31",
  "description": "INDEPENDENCE NATIONAL HISTORICAL PARK (INDE) - URGENT - PURCHASE OF TWO (2) - FEDRAMP CERTIFIED PHYSICAL AND VIDEO TRAILERS AND SOFTWARE LICENSING",
  "usaspendingUrl": "https://www.usaspending.gov/award/CONT_AWD_140P4226P0018_1443_-NONE-_-NONE-",
  "scrapedAt": "2026-08-04T04:56:47.702Z"
}
```

Both URLs above were checked live and return HTTP 200 on usaspending.gov.

## Using the data

### curl

```bash
curl -s https://raw.githubusercontent.com/ConorsCode/open-fedspend-data/main/data/awards.json | jq '.[0]'
curl -s https://raw.githubusercontent.com/ConorsCode/open-fedspend-data/main/data/top-recipients.json | jq '.[:10]'
```

### pandas

```python
import pandas as pd

df = pd.read_json("https://raw.githubusercontent.com/ConorsCode/open-fedspend-data/main/data/awards.json")
df.groupby("awardingAgency")["awardAmount"].sum().sort_values(ascending=False).head(10)
```

### JavaScript

```js
const awards = await fetch(
  "https://raw.githubusercontent.com/ConorsCode/open-fedspend-data/main/data/awards.json"
).then((r) => r.json());

const dod = awards.filter((a) => a.awardingAgency === "Department of Defense");
console.log(`${dod.length} DoD awards this window`);
```

## Source and attribution

All data comes from [USAspending.gov](https://www.usaspending.gov/), the
official open data source for US federal spending, run by the US Department
of the Treasury. This repo queries its public
[`spending_by_award` search API](https://api.usaspending.gov/api/v2/search/spending_by_award/)
directly — no scraping, no key, no login. USAspending data is public domain;
this repo's normalization/aggregation code is MIT licensed.

## Field set and pagination — verified, not assumed

USAspending's `fields` parameter is not validated against one fixed schema
the way a typed API would be, and the `sort` field must appear in `fields` or
the request errors outright. The 19-field request list used here
(`Award ID`, `Recipient Name`, `Award Amount`, `Total Outlays`, NAICS/PSC
codes and descriptions, place of performance, dates, etc.) was confirmed live
against the contracts award-type category before this repo shipped.

More importantly: **USAspending's `page_metadata.hasNext` flag is unreliable
past roughly page 100** for this endpoint when sorting by `Award Amount desc`
— it was observed live returning `hasNext: false` on a page that still had a
full 100 results, for several consecutive pages, with the real end of results
only showing up ~180 pages later as a short page. `scripts/fetch.mjs` does
not trust `hasNext`; it pages until a response comes back with fewer than 100
rows, up to a 49,900-row safety cap (USAspending's own documented ceiling for
simple page-number pagination is `page * limit <= 50,000`). If a run ever
hits that cap, `data/summary.json.hitPaginationCap` is `true` and
`awards.json` holds only the largest awards by `awardAmount`, not a complete
set for that window — check this field before treating a snapshot as
exhaustive.

## Limitations (read before relying on this for anything important)

- **7-day window only.** This is not historical data and not a full-year
  view. For anything further back, use USAspending's own bulk download tools
  or query the API directly with a custom date range.
- **Contracts only, no grants.** Award type codes A/B/C/D (BPA calls,
  purchase orders, delivery orders, definitive contracts). Grant/assistance
  awards (block/formula grants, cooperative agreements) are out of scope.
- **Obligated, not potential, amounts.** `awardAmount` is what's been
  obligated on this award transaction, not a contract ceiling or ask price.
  A row can represent one action on a much larger multi-year vehicle — see
  `data/README.md` for detail.
- **Snapshot timing.** Each row reflects what USAspending returned at
  `scrapedAt`; award data can lag real contract actions by days, and
  USAspending occasionally revises historical records.
- **No SAM.gov opportunities.** This is awarded, obligated spending only —
  not open solicitations or pending opportunities. That's a different
  USAspending/SAM.gov dataset entirely.
- **Sorted by `awardAmount` descending, capped for safety.** If a window
  ever produces more rows than the fetcher's safety cap can retrieve, the
  smallest awards for that window are the ones dropped, not a random sample
  — check `data/summary.json.hitPaginationCap`.
- **No personal data.** This dataset contains only what USAspending
  publishes about the award itself — recipient organization name/UEI, never
  individual data.

## If you need custom filters

This repo's fetcher is deliberately narrow: a fixed 7-day window, contracts
only, no agency/NAICS/recipient filtering, run once a day via GitHub Actions.
That's what keeps it free, fast, and easy to audit.

If you need award or grant data filtered by keyword, NAICS code, PSC code,
awarding agency, place of performance, or a custom date range — run on
demand instead of waiting for tomorrow's snapshot — that's a separate, paid
tool: the
[Federal Contracts & Spending Scraper on Apify](https://apify.com/studious_allergy_mig/fed-contracts-scraper).
It queries the same USAspending API plus optional SAM.gov opportunities (with
your own free SAM.gov key), pay-per-result.

This repo and that actor share no code — the actor is a TypeScript project
with input validation and per-source status reporting; this repo is a single
plain Node script meant to be read in one sitting.

## License

MIT — see [`LICENSE`](LICENSE). The code is MIT licensed; the award data
itself is US government public data from USAspending.gov.
