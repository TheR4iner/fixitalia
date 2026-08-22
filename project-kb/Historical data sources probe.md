# Historical data sources probe

## Overview

Phase 1 of the "ALL data for ALL legislatures" workstream. Probed
camera.it, senato.it, storia.camera.it, and the per-legislature
subdomains to determine what's available, at what URL, and behind
what protection (WAF, CAPTCHA, none). Output: a per-source plan for
the implementation work.

## Findings

### Camera dei Deputati -- sedute (transcripts)

Tested by `HEAD`ing `documenti.camera.it/leg{N}/resoconti/assemblea/xml/repository/sed0010/stenografico.xml`:

| Leg range | Result | Source |
|-----------|--------|--------|
| 15-19     | HTTP 200, XML available | documenti.camera.it/leg{N}/... (current scraper) |
| 13-14     | HTTP 404 on XML | data lives on `leg{N}.camera.it/_dati/leg{N}/lavori/stenografici/sed{N}/` -- HTML with two distinct markup formats per leg (see below) |
| 1-12      | HTTP 404 | PDF-only via biblioteca.camera.it / archivio.camera.it -- out of HTML scope |

The HTML/XML era for Camera transcripts begins at leg 15 (2006). Legs
13-14 (1996-2006) are on per-leg subdomains with a different document
structure. Legs ≤12 are PDF-only.

#### Camera legs 13-14 HTML transcript format

Both legs live at `leg{N}.camera.it/_dati/leg{N}/lavori/stenografici/sed{N}/`.
The entry point is `s000r.htm` (a 1990s-style HTML FRAMESET) which
references the real content via `s000.htm` (index/TOC) and chunk files
`s010.htm`, `s020.htm`, ... (one chunk per OdG topic).

**Leg 14 also exposes** `sintero.htm` -- a single-file aggregation of
the full transcript. The parser can use that as a fast path; legs
without sintero (leg 13) need to walk the chunked files.

The two legs use different speaker markup:

| Leg | Markup style |
|---|---|
| 14 | `<!O>NAME<!/O>` SGML-style processing-instruction tags around speaker names |
| 13 | Plain `<A NAME="Presidente 7643 1">NAME.` anchors (no `<!O>` envelope) |

OdG titles use a consistent pattern across both legs:
`<P><A NAME="TitoloN M"><CENTER><B>Title text</B></CENTER></A>`.
Speakers also have anchor names like `Presidente {pos1} {pos2} {pos3}`
where the position triplet encodes section, ordinal, and sub-ordinal.

**Implication**: a new parser is needed, distinct from the leg-19 XML
parser, but it can serve both legs via a small markup-style branch.
Total work: ~1 day engineering. Output rows match the existing
`parlamento_interventi` and `parlamento_odg` shapes -- no schema
changes required.

The session-number enumeration mirrors the current leg-19 Camera index
pass: probe sed1, sed2, ..., sedN with HEAD requests; stop after 40
consecutive 404s. The session date lives inside `s000.htm` (e.g.
"Sed. 100 di giovedì 21 novembre 1996") and is extractable with a
simple regex.

### Camera dei Deputati -- deputati (deputy profiles)

| Leg range | Source | URL pattern | Bot protection |
|-----------|--------|-------------|----------------|
| 19 (current) | www.camera.it | `/deputati/elenco/19-{numeric_id}/` | none |
| 1-18 (historical) | storia.camera.it | `/deputato/{first-last-YYYYMMDD-birth}/leg-repubblica-{ROMAN}` | listing CAPTCHA, detail page clean |

The numeric `id_persona` we already have **maps deterministically** to
the storia URL via the `d{numeric_id}_{leg}` token visible on each
storia detail page (e.g. Emma Bonino: id_persona=14710 → page shows
`d14710_15`). So once we know a slug, we lock it to our row without
fuzzy matching.

To **discover** slugs: the listing endpoint
`storia.camera.it/deputati/faccette/leg_repubblica:{N}` (paginated, ~600
entries per leg, ~30 pages) requires a Playwright-based scraper
similar to the senatoBrowser pattern -- storia.camera.it returns a
CAPTCHA challenge for the listing path. Detail pages themselves are
WAF-free and can be fetched with plain HTTP once the slug is known.

### Senato della Repubblica -- sedute (transcripts)

Tested via the existing `probe-senato-listing.ts` against
`/legislature/{N}/lavori/assemblea/resoconti-elenco-cronologico?year=Y`:

| Leg range | Result |
|-----------|--------|
| 13-19 | HTML show-doc anchors present (the existing pipeline works) |
| 1-12 | listing renders, but transcripts are PDF-only (no `show-doc` HTML) |

The HTML era for Senato transcripts begins at **leg 13** (1996). The
existing `senatoListingScraper` + `senatoSession` pipeline should
ingest legs 13-19 without code changes -- the URL builder already
emits `/legislature/{N}/...` for past legs. The Senato browser
already handles the AWS WAF challenge.

Note: id-space changes across legs. Leg 19 uses 7-digit show-doc IDs
(e.g. `id=1506540`). Leg 14 uses 5-6 digit IDs (`id=91291`). Both are
exposed in the listing anchors, so the scraper doesn't need to know
the magnitude.

### Senato della Repubblica -- senatori

| Leg range | Source | URL pattern | Bot protection |
|-----------|--------|-------------|----------------|
| 19 (current) | www.senato.it | `/loc/link.asp?tipodoc=sanasen&id={did}` | AWS WAF (existing) |
| 13-18 (historical) | www.senato.it | `/legislature/{N}/composizione/senatori/elenco-alfabetico/scheda-attivita?did={did}` | AWS WAF, but no fundamentally new mechanism |
| 1-12 | various older paths | likely all PDF | out of HTML scope |

`did` is the senator's numeric ID. The same ID space is used for both
current and historical senators (just different URL containers).
Whether we already have these IDs on `parlamento_persona` for senate
oratori needs a quick DB check before Phase 3.

## Open questions

- **storia.camera.it listing pagination + rate**: needs to be
  exercised under Playwright to learn how the CAPTCHA fires (per
  page? per IP? after N requests?). Affects whether a single bulk
  scrape is feasible or needs throttling.
- **Senato senatori existing id_persona format**: does our current
  parlamento_persona for chamber=senato carry the same numeric `did`
  that the historical URL expects? Needs a 1-line DB check before
  Phase 3 begins.
- **Multi-leg deputies**: when a person served in multiple historical
  legs, do we fetch their profile once and copy it to each mandato,
  or fetch per-leg? The storia URL is per-leg
  (`/leg-repubblica-XV`, `/leg-repubblica-XVI`), so the natural shape
  is per-leg, but the persona-level identity (birth date, education,
  origin) is leg-invariant. Decision affects scraper structure.

## Scope recommendation

**Achievable for the planned full ingest (HTML era)**:
- Camera sedute: legs 13-19 (legs 13-14 add a new HTML parser; legs 15-19 keep using the XML parser)
- Camera deputati: legs 1-18 via storia.camera.it (the new scraper
  works for the entire republic era, not just 13-18 -- but it only
  matters for legs where we have sedute, i.e. 13-19)
- Senato sedute: legs 13-19
- Senato senatori: legs 13-19 (existing + historical URL)

## Deferred: PDF era (legs 1-12, both chambers)

Both Camera and Senato hit the same boundary: HTML transcripts begin
in 1996 (start of leg 13 of the Republic). Earlier legs are
**PDF-only** and have been explicitly scoped out of the current
"complete the HTML data" workstream by user decision on 2026-05-17.
This section captures *why* so the choice doesn't have to be
re-derived later.

### Technical challenges that make PDFs a separate phase

1. **Text extraction is lossy and layout-dependent.** Italian
   parliamentary transcripts pre-1996 were typeset for print:
   multi-column layouts, hyphenated line breaks across pages,
   header/footer noise on every page, page numbers interleaved with
   body text. Off-the-shelf extractors (pdfplumber, pdftotext, even
   the better commercial ones) produce strings that need a layout-
   aware post-processor before they're parseable.

2. **Speaker boundary detection has no markup hook.** The HTML era
   has explicit anchors and `<!O>` tags around speaker names. PDFs
   have only typographic conventions (e.g. "PRESIDENTE." in caps,
   often boldface, sometimes with a colon). Variations across decades
   and printers mean a single regex won't suffice; an LLM-assisted
   classifier is the realistic path -- same cost shape as the Corte
   dei Conti pipeline noted in CLAUDE.md.

3. **OdG titles vs. speech vs. stage directions are visually
   distinguished, not structurally.** Title=centered+bold,
   stage-direction=italic, speech=plain. After text extraction these
   distinctions collapse to plain strings unless the extractor
   preserves font/style attributes -- and even when it does, the
   mapping is approximate.

4. **Cross-page continuity.** A single speech routinely spans 3-5
   pages with running headers in between. Stitching paragraphs across
   page breaks while discarding headers requires per-document tuning.

5. **Volume.** A leg has ~400-800 sedute, each at 50-200 pages of PDF.
   For legs 1-12 that's roughly 60,000-120,000 PDF pages to process.
   At ~$0.001/page for OCR + ~$0.005/page for an LLM correction pass,
   the budget is real but not blocking; the engineering time is the
   blocker.

6. **Identity resolution against persona records.** Pre-1996 deputies
   often have no numeric `id_persona` that's discoverable from the
   PDF text. Linking a speech to a persona requires a separate name-
   resolution step (against the storia.camera.it directory), with
   ambiguity for common surnames.

### What would unblock the PDF phase

- A working text-extraction-and-cleanup pipeline tuned for Italian
  parliamentary printers (camera.it and senato.it have slightly
  different layouts; both changed over the decades).
- An LLM-assisted classifier for speaker / odg / stage-direction
  segmentation, validated against a hand-labelled gold set.
- A persona-resolution layer that maps PDF-extracted names to
  storia.camera.it / senato.it historical-senator records.

### When to come back to this

After the HTML-era workstream is shipped and stable in production.
The data model is already designed for it (persona + mandato +
seduta + intervento), so the PDF phase will be a pure ingest path,
not a schema migration. Treat as a research project rather than a
feature.

### Phase 0 (PDF era) probe results -- 2026-06-12

First read-only probes of the legs-1-12 sources, run while the leg
13-19 ingest was still going (probes touch only the network, never the
DB). Three throwaway probe scripts under `server/scripts/`:
`_probe-pdf-camera.ts`, `_probe-pdf-sparql-sedute.ts`,
`_probe-pdf-senato.ts`.

**Camera document host (0b) -- RESOLVED to storia.camera.it.** Followed
up with `_probe-camera-catalog.ts` + several throwaway crawls. Findings:
- `archivio.camera.it/` is a **reCAPTCHA wall** (the 4.5KB body is just a
  google reCAPTCHA form). Not a usable source without CAPTCHA solving.
- `biblioteca.camera.it/` is the **library** portal (access forms,
  bollettini) -- a red herring, not the resoconti archive.
- **`storia.camera.it` is the real home of historical resoconti.** The
  `/lavori` index lists every legislature as
  `/lavori/{repubblica|regno-d-italia|regno-di-sardegna}/{N}/{ROMAN}`
  (leg overview, HTTP 200). The per-seduta drill is the FACETED endpoint
  `/lavori/{era}/leg-{era}-{ROMAN}/faccette/organo:Assemblea` (e.g.
  Republic leg I shows "Assemblea (1114)" -- 1114 assembly sessions).
  storia is jQuery-era server-rendered HTML (not a SPA, no JSON API), but
  the `/faccette/` listing endpoints are **reCAPTCHA-gated** (same wall
  the deputati `/faccette/` listings hit -- see [[Camera deputati historical URLs]]). So Camera legs 1-12 transcript discovery needs
  **Playwright + reCAPTCHA handling**, not plain HTTP. Document format
  (text PDF vs scanned image) is still UNCONFIRMED -- the CAPTCHA wall
  blocked pulling an actual transcript without a browser.

Superseded earlier-guess note: PDF
URL patterns (`documenti.camera.it/leg{N}/.../pdf/sed{NNNN}.pdf`, the
`leg{N}.camera.it` subdomain `pdfel.pdf`) all 404 / fail to connect. The
catalog hosts archivio/biblioteca exist but the per-seduta URL scheme
isn't guessable (because the real source is storia.camera.it, above).

**Camera SPARQL session metadata (0c) -- partial coverage, promising.**
`dati.camera.it/sparql` `COUNT(ocd:seduta WHERE ocd:rif_leg
repubblica_{N})` returns: leg 1 = 0, leg 5 = 0, leg 10 = 8877, leg 12 =
3074, leg 13 = 11031, leg 14 = 11208. So OCD session data exists at
least back to leg 10, but **the counts are far too high for assembly
sedute** (~400-800/leg expected) -- `ocd:seduta` almost certainly
includes commission sittings and/or finer sub-items. The class/predicate
needs refining (filter to assembly only) before it's usable as an index
source. Coverage thins out before ~leg 10 (legs 1, 5 = 0), so the
earliest republic legs likely have no OCD session graph and are
PDF-catalog-only.

**Senato SPARQL (0c) -- can't be introspected from here.** Every
aggregate / `FILTER(CONTAINS(...))` query to `dati.senato.it/sparql`
returns HTTP 403, even via the working `fetchWithRetry` +
`format=...sparql-results+json` call shape. This matches the KB note
that the senate WAF rejects complex queries -- the existing
`senatoreSparql.ts` only ever issues *simple per-id property-path*
queries, which work. Implication: we cannot cheaply enumerate Senato
seduta coverage via SPARQL. That answer must come from the listing
scrape (0a) instead.

**Senato listing (0a) -- BLOCKED on the browser environment.** The
probe needs `openSenatoBrowser()` (Playwright + system Chromium to solve
the AWS WAF), but this workspace has no Chromium installed
(`/usr/bin/chromium` absent) -- it's a separate environment from where
the Senato ingest actually runs. 0a must be run wherever Chromium +
the awswaf egress allowance exist (the VPS, or a workspace with
`apt-get install chromium` + the awswaf domain in
`EXTRA_ALLOWED_DOMAINS`). The probe script is written and ready
(`_probe-pdf-senato.ts [leg] [year]`); it dumps every anchor on an
old-leg listing, bucketed by href pattern, so the PDF anchor format
falls out of one run.

**Confirmed pipeline shape (post-extraction), decided 2026-06-12.** LLM
parsing will run a **local Ollama model** (no API spend), and only
*after* a deterministic cleaning pipeline: pdfplumber raw text (with
coords) -> geometric header/footer strip -> column detect+reorder ->
hyphenation healing -> page-seam + soft-line-break stitching ->
`cleaned_text` checkpoint -> cheap regex pre-segmentation into candidate
speaker blocks -> Ollama JSON-mode labelling of each block ->
merge-same-speaker -> `parlamento_odg`/`parlamento_interventi` ->
existing `historicalSpeakerLink` identity pass. The cleaning pipeline is
~80% of the work; the LLM step is near-mechanical on clean,
pre-segmented input. New `body_status` values planned: `pdf_pending` ->
`pdf_downloaded` -> `pdf_extracted` -> `pdf_parsed`.

### Kingdom-era (pre-1948) data -- DATA EXISTS (correction 2026-06-12)

**The earlier claim that Kingdom transcripts are "non-existent or
require palaeography, not a tractable ingest target" was WRONG on
availability.** storia.camera.it's own `/lavori` description states it
carries "i resoconti stenografici delle sedute ... **dalla I
legislatura del Regno di Sardegna alla XVII legislatura della
Repubblica**" -- i.e. the stenographic record is digitized back to
**1848** (Regno di Sardegna I). Every Kingdom legislature has a live
leg page (`/lavori/regno-di-sardegna/{1-7}/...`,
`/lavori/regno-d-italia/{1-16+}/...`, HTTP 200).

What remains true: reaching individual sessions goes through the same
reCAPTCHA-gated `/faccette/` endpoint as the Republic legs (Playwright +
CAPTCHA needed), and the 19th-century material is almost certainly
**scanned-image PDFs** -- so an OCR stage (Tesseract-ita or a vision
model) must be prepended before the standard cleaning + Ollama pipeline.
The palaeography concern is real for *extraction quality*, not for
availability.

**Plan: Phase 6 (post-Republic), after legs 1-12 ship.**
- 6a -- 20th-century Kingdom (1900-1943): cleaner scans, same path.
- 6b -- 19th-century (1848-1900): oldest/worst scans, smallest volume,
  typographically hardest. A research sub-project, but no longer
  "intractable / data doesn't exist."

## History

- **2026-06-12** -- Phase 0 (PDF era, legs 1-12) probing begun while the
  leg 13-19 ingest was still running (read-only network probes, no DB
  contention). Findings recorded in the "Phase 0 (PDF era) probe results"
  section above. Summary: Camera catalog hosts (archivio/biblioteca) are
  live + WAF-free but the per-seduta URL scheme is unknown; Camera SPARQL
  has session data back to ~leg 10 but the class needs refining; Senato
  SPARQL can't be introspected (WAF 403s aggregates); Senato listing probe
  is blocked on the missing Chromium in this workspace and must run where
  the Senato ingest runs. Also locked the post-extraction pipeline:
  deterministic cleaning -> local Ollama (no API spend) -> existing
  identity-link pass.

- **2026-06-12 (later)** -- Phase 0b resolved + a KB correction. Camera
  legs 1-12 transcripts live on **storia.camera.it** (not
  archivio/biblioteca: archivio is a reCAPTCHA wall, biblioteca is the
  library portal). Drill path is the reCAPTCHA-gated `/faccette/`
  endpoint, so Playwright + CAPTCHA is required. Bigger finding: the old
  "Kingdom-era data is non-existent / intractable" claim is **wrong** --
  storia.camera.it states it carries resoconti stenografici back to the
  I legislatura del Regno di Sardegna (1848). Reclassified pre-1948 from
  "out of scope entirely" to a planned Phase 6 (post-Republic), gated on
  an OCR stage for the scanned 19th-century material. New keeper probe:
  `server/scripts/_probe-camera-catalog.ts`.

- **2026-05-17 (afternoon)** -- Probed Camera legs 13-14 transcript
  format on `leg13.camera.it` / `leg14.camera.it`. Both serve HTML
  from `/_dati/leg{N}/lavori/stenografici/sed{N}/`. Leg 14 also
  publishes a `sintero.htm` single-file aggregation; leg 13 only has
  the chunked `s010.htm`, `s020.htm`, ... files. Speaker markup
  differs by leg: leg 14 uses `<!O>NAME<!/O>` tags, leg 13 uses plain
  `<A NAME="Presidente N M">NAME.` anchors. New parser needed, ~1
  day work, no schema changes. Also expanded the deferred-PDF
  section with concrete technical reasons after user explicitly
  asked for them.

- **2026-05-17 (morning)** -- Initial probes completed. See
  [[Camera deputati historical URLs]] for the existing mitigation
  this workstream is meant to retire. The earlier KB note was
  written under the assumption that historical camera deputati
  lived on www.camera.it under a different path -- the probe
  showed they live on a separate subdomain (storia.camera.it) with
  a fundamentally different ID scheme.
