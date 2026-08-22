# Competitive feature analysis

## Overview

What the Italian institutional parliamentary sites (Camera, Senato, the
`dati.*` open-data portals, storia.camera.it) actually offer as
functionality, and which search + product features would make fixitalia
a compelling alternative rather than a redundant mirror. Companion to
[[Monetization research - parliamentary database]] (which covers who
would pay); this note is about the product surface itself.

Grounded in live probes of the institutional sites on 2026-06-12 plus
the open-data findings already recorded in [[Parlamento section]] and
[[Historical data sources probe]].

## What the institutional sites provide

| Feature | Camera (camera.it) | Senato (senato.it) | dati.camera.it / dati.senato.it |
|---|---|---|---|
| Per-seduta transcript view | HTML / XML / PDF | yes (AWS-WAF walled) | -- |
| Full-text search | keyword + facets (`q`, `qtype`, `rows`, `page`) | yes (behind WAF) | -- |
| Deputy / senator profiles, groups | yes | yes | yes (LOD/SPARQL) |
| Voting records (votazioni) | yes | yes | yes |
| Bills / legislative iter (ddl, atti) | yes | yes | yes (Akoma Ntoso XML) |
| Calendar of works | yes | yes | -- |
| Web TV (session video) | webtv.camera.it | webtv.senato.it | -- |
| Historical archive | storia.camera.it (1848+) | partial | -- |
| Bulk / programmatic access | -- | -- | SPARQL + REST (XML/JSON) + GitHub + ZIP |
| Faceted historical browse | storia `/faccette/` (reCAPTCHA-gated) | -- | -- |

dati.senato.it segments its own audience explicitly on its home page:
"Ricercatori e Analisti / Giornalisti e Blogger / Aziende e
sviluppatori." They know the demand exists; they serve it only as raw
RDF.

## The gaps (fixitalia's opening)

Every institutional weakness is a **siloing** problem, not a data
problem. The data is public; it is fractured by chamber, by
legislature, and by access method (human HTML vs machine SPARQL).
fixitalia's value is de-siloing -- and the two hard pieces (a unified
cross-chamber schema + a BM25 full-text index) are already built.

1. **No cross-chamber surface.** Camera and Senato are entirely separate
   sites with different IDs, layouts, and search.
2. **No cross-legislature person view.** You cannot ask "everything X
   said across 40 years" anywhere. fixitalia's persona+mandato model
   plus the [[Historical speaker mandato linking]] backfill enables it.
3. **No ranked / highlighted search.** Institutional search returns flat
   keyword lists; no relevance ranking, no snippets. fixitalia has
   `search::score` + `search::highlight` (see [[Parlamento section]]).
4. **No queryable Senato transcript corpus** at all (WAF + PDF era).
5. **SPARQL-or-nothing for bulk.** Il Sole 24 Ore InfoData (Jan 2023)
   called the portals "not for everyone" and "equally difficult."
6. **Dated, desktop-only UI.** jQuery-era; 1990s framesets for old legs.

## Ranked feature roadmap

Ordered by leverage (reuse of existing infra) descending.

1. **Unified cross-chamber + cross-legislature ranked search** with
   facets (chamber / legislatura / date range / speaker / party-group /
   OdG topic) and highlighted snippets. Infra already exists; this is the
   headline differentiator and the foundation for 2 and 4. **Near-term
   core.**
2. **Speaker-scoped search & person timelines** -- all of a speaker's
   interventions on a topic across every mandato; party-switching
   ("cambi di gruppo") history; per-speaker stats (intervention counts,
   most-active sessions, topic profile). Structurally impossible on the
   institutional sites; trivial on our model. **Near-term core.**
3. **Semantic search** -- a local embedding model over the corpus:
   "find passages *about* a concept," not just keyword match. No Italian
   institutional site does this. **Differentiating roadmap (real build).**
4. **Mission-aligned analytics** -- topic/word trends over time,
   attendance/absenteeism, and the unique synthesis: cross-referencing
   transcripts <-> votes <-> fixitalia's spending datasets. The
   triangulation no institutional site will build. **Differentiating
   roadmap (real build).**
5. **Clean REST/JSON API + bulk export** -- fills the "SPARQL is too
   hard" gap and doubles as the Path B/C monetization surface from
   [[Monetization research - parliamentary database]]. **Monetization
   bridge.**
6. **Alerts / subscriptions** -- notify when a speaker or topic appears.
   Zero institutional equivalent. **Engagement / retention.**

## Key tradeoff

Items 1-2 reuse infrastructure already built (BM25 index + persona/
mandato schema) -- cheap, high-impact, do first. Items 3-4 are the
high-ceiling differentiators but are genuine builds (embedding pipeline;
analytics layer + dataset joins). Recommendation: lock 1+2 as the
near-term competitive core, treat 3-4 as the differentiating roadmap,
5 as the monetization bridge.

## Open questions

- Which fixitalia non-parliament datasets (spending, ANAC, etc.) are
  far enough along to power the transcripts<->votes<->spending
  triangulation in item 4? That join is the single most defensible
  feature and depends on the rest of the platform's data maturity.
- Semantic search model + storage: local embedding model choice and
  whether SurrealDB's vector support is sufficient or a separate vector
  store is needed.

## History

- **2026-06-12** -- Note created. Inventoried institutional functionality
  via live probes (camera.it resoconti search form fields, dati.senato.it
  audience segmentation, storia faccette gating) and cross-referenced the
  open-data gaps from the monetization research. Produced the 6-item
  ranked roadmap. Decision pending on near-term UI focus (items 1-2 are
  the recommended start).
