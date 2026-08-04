# data/

This directory holds the current snapshot of the dataset, regenerated daily by
`.github/workflows/update.yml` running `scripts/fetch.mjs`.

## What "the window" means

Every file here covers a **rolling 7-day window**, recalculated fresh on each
run: `today` back through `today - 6 days` (both dates inclusive, UTC). It is
not a fixed calendar window — running the fetcher tomorrow shifts the whole
window forward one day. `data/summary.json`'s `window` field records the exact
`startDate`/`endDate` used for the snapshot currently in this directory.

7 days was chosen, not 30, because a 30-day window of every federal prime
contract award routinely exceeds USAspending's pagination limits for this
endpoint (see "USAspending pagination behavior" below) — 7 days keeps a
typical week's ~25,000-30,000 awards comfortably inside what the fetcher can
reliably retrieve in one run.

## Files

- `awards.json` — every contract award in the window, as a JSON array. One row per award.
- `awards.csv` — the same data as CSV.
- `top-recipients.json` — recipients ranked by total obligated **within this window only** (top 100).
- `by-agency.json` — every awarding agency, total obligated and award count, **within this window only**.
- `by-naics.json` — every NAICS code present in the window, total obligated and award count.
- `summary.json` — window dates, total awards, total obligated, total outlays, run duration, and notes on what the dollar figures mean.

None of the aggregate files are full-year or all-time totals. They are sums
over whatever 7-day window is currently in `awards.json` — check
`summary.json.window` before citing a number from them.

## Schema (`awards.json` / `awards.csv`)

| Field | Type | Notes |
|---|---|---|
| `awardId` | string \| null | USAspending's "Award ID" (piid/fain), as published |
| `recipientName` | string \| null | Vendor/recipient legal name |
| `recipientUei` | string \| null | Recipient's Unique Entity Identifier, when disclosed |
| `awardingAgency` | string \| null | Top-tier awarding agency |
| `awardingSubAgency` | string \| null | Sub-agency/component |
| `awardAmount` | number \| null | **Obligated amount for this award transaction** — see "What the dollar figures mean" below |
| `totalOutlays` | number \| null | Actual dollars disbursed to date against the award, where USAspending reports it |
| `awardType` | string \| null | Contract type, e.g. "DEFINITIVE CONTRACT", "PURCHASE ORDER" |
| `naicsCode` / `naicsDescription` | string \| null | Industry classification |
| `pscCode` / `pscDescription` | string \| null | Product/Service Code |
| `placeOfPerformanceState` / `placeOfPerformanceCountry` | string \| null | Where the work is performed |
| `startDate` / `endDate` | string \| null | Award's period of performance (not when it appeared in this window) |
| `description` | string \| null | USAspending's award description, as published (often terse or boilerplate) |
| `usaspendingUrl` | string \| null | Direct link to the award's public page on usaspending.gov |
| `scrapedAt` | string | ISO timestamp of the fetch that produced this row |

Every field is `null`, never `0` or `false`, when USAspending doesn't report a
value — so you can tell "not disclosed" apart from an actual zero-dollar
award or empty string.

## What the dollar figures mean (read this before citing a number)

- **`awardAmount`** is USAspending's "Award Amount" for this specific award
  transaction — the **obligated** amount, i.e. money the government has
  actually committed to pay under this action. It is **not** a contract
  ceiling, not a total potential value, and not a lifetime spend estimate.
  A single award transaction can represent one modification on a huge
  multi-year vehicle; `awardAmount` is that transaction's obligated dollars,
  not the vehicle's total worth.
- **`totalOutlays`** is USAspending's "Total Outlays" — actual dollars
  disbursed to date against the award, where reported. This is often smaller
  than `awardAmount` (money can be obligated before it's paid out) and is
  `null`, not `0`, when not reported.
- **`startDate`/`endDate`** describe the award's period of performance, not
  when the money moved. An award with `startDate` from years ago can still
  appear in this window if USAspending's records show recent activity
  matching the query window — see "Snapshot timing" below.
- The two sample rows in the top-level README are real output from this
  dataset's most recent verified run, both obligated amounts in the tens of
  billions — these are large multi-year national-lab management contracts,
  not typical rows. Most rows in a given week are far smaller; see
  `by-naics.json`/`by-agency.json` for the distribution.

## USAspending pagination behavior (why this matters for completeness)

USAspending's `spending_by_award` search endpoint paginates with simple
page-number pagination, and its own documentation states this style is
capped at `page * limit <= 50,000` total results. In practice, this
fetcher also found that the endpoint's `page_metadata.hasNext` flag is
**unreliable past roughly page 100** when sorting by `Award Amount desc` —
it reports `false` even when the next page still returns a full 100 rows.
Because of that, `scripts/fetch.mjs` does not trust `hasNext`; it keeps
paging until a page comes back with fewer than 100 rows (the real
end-of-results signal), up to a 49,900-row safety cap.

`data/summary.json.hitPaginationCap` records whether a given run hit that
safety cap. If `true`, `awards.json` contains only the **largest awards by
`awardAmount`** in the window (the fetcher sorts descending), not a complete
set — check this field before treating the dataset as exhaustive for a given
week.

## Snapshot timing

Each row reflects what USAspending's API returned at `scrapedAt`. Federal
award data itself can lag real-world contract actions by days, and USAspending
occasionally revises historical records — don't assume a row is either
brand-new or final just because it appeared in a recent run.

See the top-level README for the full field-set verification note, sample
output, and known limitations.
