# Parlamento coverage gaps (road to 100%)

## Overview

Exact accounting of missing/incomplete parlamento sedute as of 2026-06-17,
after the Meilisearch migration + orphan cleanup. Read-only upstream recon done
to separate real gaps from phantoms before any re-ingest. Goal: 100% HTML-era
coverage (legs 13-19; legs 1-12 are PDF-only and out of scope -- see
[[Historical data sources probe]]).

## The picture after recon

Starting suspicion was ~525 sedute (44 in-range row gaps + 198 below-#100 +
283 empty). After probing upstream, the real number is **~327**, split:

### 1. PHANTOM -- 198 sedute, NOT missing (zero work)
Camera 13 & 14 sessions 1-99 simply do not exist upstream: `HEAD
leg13.camera.it/_dati/leg13/lavori/stenografici/sed{1..99}/s000r.htm` -> 404;
sed100+ -> 200. The per-leg archive numbers assembly stenografici **from
sed100**. So our camera 13/14 coverage (sed100..max) is already complete for
what the source publishes. (Date inside s000.htm confirms: "Sed. 100 di ...
novembre 1996".)

### 2. CAMERA real gaps -- 36 sedute (re-fetchable NOW, no throttling needed)
All 36 verified present upstream (HTTP 200); the original index pass skipped
them (transient failures). Camera is WAF-free -> safe, deterministic targeted
re-ingest by numero.
- camera 13 (18): 172,221,251,278,337,364,383,416,447,475,494,546,559,594,632,663,684,731
- camera 14 (17): 107,167,195,290,332,351,365,430,449,483,519,553,578,594,636,715,741
- camera 15 (1): 276  (leg15-19 source: documenti.camera.it/leg{N}/resoconti/assemblea/html/sed{NNNN}/stenografico.htm)
- leg13/14 source: leg{N}.camera.it/_dati/leg{N}/lavori/stenografici/sed{num}/ (no zero-pad)

### 3. SENATO -- ~291 sedute (needs the WAF browser path + throttled ingest)
Senato is behind the AWS WAF: plain `curl` of a show-doc URL returns HTTP 202 /
empty body. Verifying content requires Playwright + Chromium + the WAF handshake
(senatoBrowser.ts, `CHROMIUM_PATH` default /usr/bin/chromium -- NOT in PATH on
the host right now, needs install/verify). The WAF also volume-limits sustained
fetching, so a full backfill has to run in throttled, resumable chunks rather
than as one long pass.
- **senato 15: 276 "empty"** -- rows exist with resolved html_url + odg (so the
  index pass worked), but body extraction yielded 0 interventi and was marked
  `ok` (body_error=None). The first ~7 sessions DID get speeches (168/99/21/38...
  interventi), then nothing -- classic mid-run break. Almost certainly
  re-fetchable. MUST inspect one real page via the browser to confirm
  parser-miss (re-parse only) vs broken-fetch (re-fetch). Biggest single chunk.
- **senato 13: 8 missing rows** -- not in DB at all: 449,609,695,732,915,1025,1031,1048.
  Need the listing scraper to discover show-doc URLs, then ingest.
- **7 misc errors** -- senato 13 #459/#461 (empty, "no blocks extracted"), senato
  14 #221 (partial 0/305), senato 14 #403 + senato 16 #737 (show-doc ErrorPage /
  invalid id), senato 17 #381 (ERR_CONNECTION_CLOSED), senato 17 #866 (stuck
  'ingesting' flag). Re-run individually.

## Recommended sequence
1. Camera 36 now -- unthrottled, fast, gets camera to 100%.
2. Senato 15: one browser fetch of a sample empty page -> confirm parser vs
   refetch -> run the 276 in throttled chunks.
3. Senato 13 gaps (8, listing-scraper discovery) + 7 misc re-runs.

## Method note
"Missing rows" (numero gaps) vs "empty rows" (interventi_n=0) are distinct:
gaps need the index pass to create the seduta, empties need only the body pass.
The orphan-cleanup that preceded this (camera 19 #24-49 stale-duplicate
interventi) is in.

## History
- **2026-06-18 (CAMERA heavy verification -- coverage perfect)** -- Ran the
  task-#19 deep cross-check on camera. **Coverage is provably complete**: every
  leg is exactly `1..max` (13:800, 14:757, 15:278, 16:739, 17:800, 18:741,
  19:676 = 4791 sedute), `distinct(numero) == total` per leg (no duplicates), and
  `total == max` with `min == 1` (no gaps). All `body_status='ok'`. **Content
  distribution healthy**: 4715 sessions >=10 interventi, only the low tail is
  small (16 with 2-4, 59 with 5-9 -- plausibly short sittings), and exactly **1**
  zero-interventi session. That one is **camera 13 #241 (1997-09-15)** -- an
  UPSTREAM-MALFORMED source: that single session's pages were published WITHOUT
  the `<A NAME>` speaker anchors the parser (correctly) keys on (neighbors sed240
  had 252 speaker anchors, sed242 had 58; sed241 had 0). The speeches exist as
  plain text ("PRESIDENTE. ...") but lack the anchor scaffolding, so 0 interventi
  extracted while the 7 `Titolo` odg anchors gave odg_n=7. Parser is right, source
  is broken -- same class as the senato 5. Accepted as an upstream defect (chasing
  it = a risky non-anchor text heuristic across 4790 healthy sessions for 1).
  Camera content extraction otherwise clean.
- **2026-06-18 (SENATO DONE -- parlamento effectively 100%)** -- Senato finished
  at **4972/4977 ok (99.9%)**. senato 15 ran 45->283/283 ok in a single chunk
  (zero WAF, ~84 min); a misc sweep recovered 2 more (leg14 #221, leg17 #866).
  The leg-13 "8 missing numeri" were confirmed **NOT real** (senato numbering
  gaps -- the full listing scrape inserted 0 of them). 5 residuals remain and
  were **accepted by the user as genuine upstream gaps** after manual URL checks:
  senato 13 #459/#461 (1998, "no blocks extracted from HTML" -- transcript-less
  pages), 14 #403 (id=114291) + 16 #737 (id=663669) (show-doc ErrorPage / doc
  doesn't exist upstream), 17 #381 (partial 520/521 -- the 521st intervento is
  absent on their side). **CAVEAT: senato 17 #381 holds 520 real interventi --
  never wipe/reset-destroy it to chase the missing 1; only the upstream source is
  incomplete.** Detail + the 5 URLs in the local operator notes. Camera was
  already 100%, so the parlamento dataset is complete bar these 5 upstream-missing
  rows.
- **2026-06-17 (camera DONE + two bug fixes)** -- CAMERA is now 100% (all 7
  legs contiguous, every seduta ok, current through 2026-06-16).
  - **Numbering fix**: the leg 13/14 `_dati` session dir is zero-padded to 3
    digits (sed001..sed099, sed100..); the index built `sed${num}` unpadded, so
    sed1-99 404'd and sessions 1-99 of both legs were missed (the early-stop
    survived because headers.length was still 0 during the 404 run). Fixed with
    padStart(3) in cameraHistoricalIndex.ts. Re-ingest found leg13 +117 (1-800
    contiguous), leg14 +116 (1-757). So the 198 were REAL after all, not phantom.
  - **leg15 #276**: a source typo -- date meta content="2008220" (7 digits, the
    month lost its leading zero) -- failed the strict \d{8} regex and the seduta
    was silently dropped. Added a title-meta Italian-date fallback + a LOUD warn
    on unparseable-but-200 in cameraIndex.ts. #276 ingested (314 interventi).
  - **"interventi stop at February" sort bug** (NOT missing data): /sedute with
    a from/to date filter let SurrealDB serve the range via idx_seduta_data and
    emit ASCENDING, silently ignoring ORDER BY data DESC -> the "Più recenti"
    2026 view showed Jan/Feb first and June on the last page. Fixed with
    `FROM parlamento_sedute WITH NOINDEX` (table is ~9.5k rows; scan is sub-10ms).
  - Remaining for 100%: SENATO only (senato 15's 276 empties, senato 13's 8 row
    gaps, 7 misc) -- needs the WAF browser path.
- **2026-06-17** -- Read-only recon. Resolved the 198 below-#100 as phantom
  (source numbers from 100). Verified all 36 camera in-range gaps exist upstream
  (re-fetchable, unthrottled). Confirmed senato needs the WAF browser path (plain
  curl -> 202). Characterised senato 15's 276 empties as a likely mid-run break.
