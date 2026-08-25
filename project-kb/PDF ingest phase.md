# PDF ingest phase

## Overview

Three bodies of parliamentary record exist only as PDF, and they are the last
large gaps in the corpus:

| Target | Volume | Why it matters |
|---|---|---|
| Camera bollettini, legs I-XIX | **22,658** | The ONLY committee record for legs 1-16 |
| Senato resoconti stenografici di commissione | tens of thousands | The only verbatim Senato committee text |
| Camera + Senato Aula, pre-1996 | see [[Historical data sources probe]] | The only plenary record before leg 13 |

They share one pipeline, so this is a single build reused three times, not three
projects. This note is the plan for that pipeline.

Related: [[Parlamento commissioni]], [[Historical data sources probe]],
[[Parlamento section]], [[Meilisearch search layer]].

## What the probing established

These are measurements, not assumptions. Every number below was verified
against live documents on 2026-08-24.

### 1. Enumeration is free

`dati.camera.it/sparql` exposes `ocd:bollettino` with `dc:date`, `ocd:rif_leg`
and a `dct:isReferencedBy` document URL -- 22,658 rows covering legislature I
to XIX. One query replaces a crawl:

```sparql
PREFIX ocd: <http://dati.camera.it/ocd/>
PREFIX dc:  <http://purl.org/dc/elements/1.1/>
PREFIX dct: <http://purl.org/dc/terms/>
SELECT ?s ?date ?leg ?url WHERE {
  ?s a ocd:bollettino ; dc:date ?date ; ocd:rif_leg ?leg ; dct:isReferencedBy ?url .
}
```

URL shapes:

```
legs 13,15,16:  /_dati/leg{N}/lavori/Bollet/{YYYYMM}/{MMDD}/pdf/intero.pdf
legs 1-12:      /_dati/leg{N}/lavori/Bollet/{YYYYMMDD}_00.pdf
leg 14:         /_dati/leg{N}/lavori/Bollet/{YYYYMM}/{MMDD}/pdf/frontesp.pdf   <-- see open items
```

Capital B in `Bollet`. Lowercase 404s.

### 2. No OCR is needed -- Camera already did it

Every era ships an embedded text layer. The historical scans were OCR'd by the
Camera itself years ago:

| Sample | PDF producer | Pages | Extracted chars |
|---|---|---|---|
| leg 5 (1968) | Acrobat Capture 3.0 | 2 | 4,509 |
| leg 10 (1987) | Acrobat 5.0 Paper Capture Plug-in | 7 | 7,218 |
| leg 13 (1996) | PDFsharp (digital-born) | 4 | 6,951 |

This removes the single most expensive component from the plan. **Do not build
an OCR stage.** Budget instead for OCR-*error* handling, which is a different
and much cheaper problem.

### 3. Use plain `pdftotext`, NOT `-layout`

The historical bollettini are two-column. `pdftotext -layout` preserves visual
position and therefore interleaves the columns into unreadable alternating
fragments. Default mode uses reading order, recovers the columns correctly, and
rejoins hyphenated line breaks:

```
-layout : "La Giunta .procede all'elezione del Presi-   nel XVI collegio (Siena), per la Demo-"
default : "La Giunta .procede all'elezione del Presidente, dei due Vicepresidenti..."
```

This one flag is the difference between a usable corpus and garbage. `-raw`
occasionally orders multi-line headings better and is worth keeping as a
cross-check for heading detection only.

### 4. OCR error profile

Sentence structure survives well; damage is at word level and is systematic
rather than random:

- run-together words: `GIUNTAPROWISORIA` (also `VV` read as `W`)
- roman-numeral confusion: `XYII` for `XVII`
- stray punctuation: `La Giunta .procede`, `tre'`
- missing spaces after accents: `GIOVEDI6 GIUGNO`
- page artifacts: `PAGINA BIANCA`

Systematic means a rule table handles most of it. It also means an LLM is NOT
required to make the text readable -- only, at most, to adjudicate ambiguous
structure.

### 5. Volume

Mean ~12,000 extracted chars per bollettino across the sample, so roughly
**272M chars / ~68M tokens** for the full Camera set.

## Design decisions

### The LLM must never rewrite the record

This is the load-bearing constraint of the whole phase.

Silently "correcting" a 1968 parliamentary record with a language model
fabricates history. It is also unfalsifiable after the fact: once the corrected
text is in the index there is no way for a reader to tell a real sentence from
a plausible reconstruction. For a project whose entire value proposition is
"the official record, made legible", that is fatal.

Therefore:

- The stored text is the **verbatim** `pdftotext` output. Always.
- The LLM's output is **structure only**: character offsets, labels, section
  boundaries, speaker attributions. It emits pointers into the text, never
  replacement text.
- Deterministic OCR fixes (the rule table above) are allowed, applied to a
  SEPARATE `testo_normalizzato` field, with `testo` untouched.
- Every LLM-derived field carries provenance (`source: 'llm'`, model id,
  prompt version) so it can be recomputed or repudiated wholesale.

### Deterministic first, LLM only on exception

The committee names in a bollettino are a **closed vocabulary** -- the LOD
gives the roster of organi per legislature. Section segmentation is therefore a
matching problem against a known list, not a reasoning problem. The same holds
for dates, sitting times and the standard headings ("SEDE REFERENTE", "IN SEDE
CONSULTIVA", "AUDIZIONI").

Expect the rule-based parser to fully handle the large majority of documents.
Route to the LLM ONLY documents where the parser's confidence check fails
(unmatched heading, no sections found, section text implausibly long/short).
This is what makes the compute budget tractable -- see below.

### Model and placement

Per [[homenet/local-llm-homelab]]:

- **lilith (RTX 3090, 24 GB)** runs Qwen3.5-27B Q4 under Ollama. This is the
  quality tier and the right home for the exception path.
- **lilith has no Wake-on-LAN and is off overnight.** The job must therefore be
  interruptible at any instant and resumable with zero loss -- the same
  contract the existing parlamento ingest already meets. Do not design anything
  that assumes a long uninterrupted run.
- **Energy is a hard constraint** in that homelab. Minimising LLM calls is not
  only a speed concern.
- The always-on CPU tier (Qwen3.5-4B on the Minisforum) is too slow for bulk
  work but is a reasonable place for cheap triage classification if the
  exception rate turns out high.
- If a structured-output model with constrained JSON decoding is wanted,
  **vLLM is already the settled second endpoint** for non-GGUF weights -- do
  not introduce a third backend.

### Compute budget

68M tokens of input if every document went to the model. On a 3090 running a
27B Q4, prefill dominates for an extraction task with short outputs; at a
conservative ~800 tok/s that is **~24 GPU-hours** for a full pass -- days of
wall-clock given lilith's duty cycle, and against the energy constraint.

At an assumed 15% exception rate that drops to **~4 GPU-hours**, which is a
couple of evenings. The exception rate is therefore the number that decides
whether this phase is cheap or expensive, and it is the first thing to measure
(Phase 2 exit criterion).

### Data model: a bollettino is not a seduta

A bollettino is a whole-day publication covering EVERY committee that sat that
day, and its content is a third-person summary, not a verbatim exchange. It
does not fit `parlamento_interventi` cleanly and must not be forced into it.

Proposed shape, to be confirmed in Phase 1 against real documents:

- one `parlamento_sedute` row per (committee x day) section, `organo =
  'commissione'`, `tipo_resoconto = 'bollettino'` -- a third value alongside
  `stenografico` and `sommario`, so the reader can label it precisely;
- section text stored whole;
- speaker turns extracted **where they exist** (later legislatures increasingly
  have them) and simply absent where they do not, rather than synthesised.

A sitting with no speaker turns is a legitimate outcome here, not a parse
failure. The existing `body_status` machinery already distinguishes these.

## Phases

### Phase 0 -- storage

The corpus is ~272 MB of raw text. At the measured expansion ratio of **11.43
bytes stored per byte of text** (see [[Parlamento commissioni]]) that lands at
**~2.9 GB** across SurrealDB + Meilisearch.

`/home` has 15.5 GB free as of 2026-08-25, so the PDF phase fits comfortably on
its own. It does NOT fit alongside a full Senato committee backfill. Before
committing to both, either:

- tune the Meili index (it currently stores the full `testo` as a retrievable
  attribute as well as indexing it; `displayedAttributes` trimming and dropping
  redundant stored fields is the cheapest win), or
- add storage.

Meili is a rebuildable replica of SurrealDB, so it is the safe thing to shrink
or drop and rebuild. **Exit criterion: at least 2x the estimated workload free before Phase 5**, so a
bad estimate cannot fill the disk mid-run.

### Phase 1 -- extraction library + gold set

Build `server/lib/ingest/pdf/`:

- `fetchPdf.ts` -- polite fetch with the existing retry/throttle helpers
- `extractText.ts` -- `pdftotext` (default mode) wrapper, page-aware, returning
  text plus per-page offsets
- `normalize.ts` -- the deterministic OCR rule table, writing a separate field

Hand-label a **gold set of ~40 documents**, stratified across legislature
(1948 / 1968 / 1987 / 1996 / 2006 / 2016) and document shape (single vs
multi-committee, with and without speaker turns). This is the entire basis for
every accuracy claim later; it is worth doing carefully and only once.

Exit criterion: extraction is byte-stable and the gold set is agreed.

### Phase 2 -- deterministic structure parser

Segment into committee sections by matching against the LOD organi roster for
that legislature; detect standard headings; detect speaker turns where the
typography marks them.

Emit a **confidence score** per document, and measure the exception rate
against the gold set.

Exit criterion: the exception rate is known and precision on confident
documents is >= 95% against the gold set. **This is the gate that sizes the
rest of the phase.**

### Phase 3 -- LLM exception path

Only for documents Phase 2 flags. Constrained JSON output (offsets and labels,
never prose), one document per call, provenance recorded on every field.
Validate that every returned offset actually lands on the claimed text -- a
model that invents a span must fail loudly rather than write a bad row.

Exit criterion: LLM path measurably beats the deterministic parser on the
exception subset, verified on held-out gold documents.

### Phase 4 -- validation harness

An accuracy budget stated up front and checked automatically:

- section boundary precision/recall vs gold
- committee attribution accuracy
- text-coverage ratio (extracted chars / pdftotext chars) -- catches silent
  drops
- a sampling CLI that prints extraction next to the source page for eyeballing

Unlike the HTML path there is no natural success signal, so this harness IS the
success signal.

### Phase 5 -- pilot ingest

One legislature end to end. **Leg 13** is the right pilot: digital-born text
(so failures are structural, not OCR), and it is adjacent to the existing HTML
corpus so results can be sanity-checked against neighbouring data.

### Phase 6 -- full Camera ingest

Legs 1-16, resumable, checkpointed per document exactly like the existing
parlamento ingest. Runs opportunistically whenever lilith is up.

### Phase 7 -- Senato committee stenografici

Reuses Phases 1-4 wholesale. Enumeration differs: ids come from the
`listastencomm` year listings behind the WAF, and the PDF id space is disjoint
from the SommComm show-doc id space. Closes the verbatim gap and the
Camera/Senato asymmetry recorded in [[Parlamento commissioni]].

### Phase 8 -- pre-1996 Aula

Same machinery, different source. See [[Historical data sources probe]].

## Open items

- **leg 14 (1,534 bollettini) has no reachable full text.** Its LOD URL is a
  `frontesp.pdf` cover page, `intero.pdf` 404s in the same directory, and the
  modern bollettino path does not cover leg 14. The content is presumably split
  per-committee under a filename convention not yet found. 7% of the Camera
  corpus; do not block the phase on it.
- Confirm the `tipo_resoconto = 'bollettino'` model against real multi-committee
  documents in Phase 1 before committing schema.
- Measure whether the 4B CPU model on the always-on box is good enough for
  triage classification, which would let exception routing run even when lilith
  is down.

## History

- **2026-08-24** -- Plan written. Established by probing: LOD enumeration of all
  22,658 Camera bollettini with document URLs; embedded text layers in every
  era (Camera pre-OCR'd its scans, so no OCR stage is needed); plain
  `pdftotext` beats `-layout` on the two-column historical format; the OCR
  error profile is systematic; leg 14 full text unreachable.
