# Overview

## What this project is

A civic tech platform that makes Italian public administration data accessible and understandable to the general public. Italian law requires government bodies to publish open data, but the data is scattered across dozens of fragmented portals in formats (raw CSV, XML, PDF, RDF) that are effectively inaccessible to non-specialists. This platform aggregates, analyzes, and presents that data with plain-language narrative context and clear visualizations, so that legally public information is actually public in practice.

The platform focuses on patterns that indicate inefficiency, mismanagement, and waste of public funds: cost overruns on public works, unfinished infrastructure, anomalous procurement patterns, unspent EU funds, and regional disparities in public service delivery. All data is sourced directly from official government portals and every data point links back to its primary source. Anomaly flagging is statistical and framed explicitly as "pattern that warrants attention", never as legal accusation.

## Audience

The Italian general public. Not researchers, not journalists, not data scientists. Every design decision must serve clarity and trust for a non-specialist reader who arrives on a phone.

## MVP scope

The MVP is organized around five thematic sections, each self-contained and understandable without having visited the others:

- **Appalti** (Public procurement): ANAC / BDNCP data, surfacing single-bidder tenders, repeated direct awards to the same supplier, abnormal price deltas between base and awarded amounts, and geographic distribution of spend.
- **Opere Incompiute** (Unfinished public works): MIT registry of started-and-never-completed works, with geospatial mapping and cross-reference to the original ANAC contracts to reconstruct full spend history.
- **Fondi Europei** (EU cohesion funds): OpenCoesione data showing allocated vs. actually disbursed amounts by region, deadline tracking against the 2026 PNRR expiry, and projects with near-zero disbursement after years of activity.
- **Spesa Pubblica** (Public spending): MEF / RGS BDAP and SoldiPubblici data on per-capita expenditure on essential services across regions, payment delays to suppliers, and cost-per-unit-of-service benchmarks computed against ISTAT denominators.
- **Parlamento** (Parliamentary activity): scraped Camera/Senato data plus OpenParlamento for attendance, voting records, bills proposed vs. approved ratios, and cross-referencing declared priorities against actual votes.

A global search across municipalities, contracting authorities, companies, CUP, and CIG codes is a primary entry point and must work from day one for users who arrive with a specific case in mind.

## Initial entities and pages

**Top-level sections** (persistent top navigation):
- Appalti
- Opere Incompiute
- Fondi Europei
- Spesa Pubblica
- Parlamento

**Cross-cutting features:**
- Global search (municipality, contracting authority, company, CUP, CIG)
- Per-entity drill-down pages (a single municipality / contracting authority / supplier shows everything the platform knows about it)
- Source links on every data point back to the official government portal

**Core data sources** to ingest:
- **ANAC / BDNCP** -- Public procurement (REST API + bulk CSV/JSON, monthly OCDS, weekly analytics). Every contract above 40k EUR plus SmartCIG below. Key signals: single-bidder tenders, repeated direct awards, base-vs-awarded price deltas.
- **OpenCoesione** -- EU cohesion funds (bulk CSV, bimonthly). All EU Structural Funds, FSC, PAC across cycles 2000-2006, 2007-2013, 2014-2020, 2021-2027. Key signals: allocated vs. disbursed by region, 2026 PNRR deadline tracking, stalled projects.
- **OpenCUP** (Presidenza del Consiglio / DIPE) -- Public investment projects tracked by CUP from approval through completion. Key signals: cost evolution from initial to current estimate (overruns), cross-reference to ANAC on the same CUP for full spend history.
- **MIT Anagrafe delle Opere Incompiute** -- Registry of started-and-never-completed public works (CSV/Excel bulk). Includes original budget, funds disbursed, year started, reason for interruption.
- **MEF / RGS BDAP** -- Financial flows of all public administrations (web UI + downloadable datasets, RDF via NoiPA). Revenues, expenditures by category, debt, personnel costs, committed vs. paid amounts.
- **SoldiPubblici** (MEF, on top of Banca d'Italia SIOPE) -- Payment-level expenditure transactions of public administrations. Granular spend useful for cross-referencing against procurement contracts. Administrations that fail to upload are themselves a signal.
- **ISTAT** -- Statistical indicators (SDMX REST API). Demographic, economic, social indicators at national / regional / municipal level since ~1995. Used as denominators for per-capita and benchmarks for regional comparisons.
- **Parlamento Italiano** (camera.it, senato.it; OpenParlamento by Fondazione Openpolis for structured data) -- Bills, votes, attendance, parliamentary questions, committee activity.
- **Corte dei Conti** -- Annual financial audit reports (referti) and rulings on erariale damages. PDF documents requiring text extraction and LLM-assisted parsing. High-credibility source: the government auditing itself.

## UI/UX principles

The primary audience is the Italian general public, not specialists. Every design decision must serve clarity and trust.

- **Layout and navigation**: Clean, uncluttered layout with strong visual hierarchy. Persistent top navigation gives access to the main thematic sections. Each section is self-contained and understandable without having visited others first.
- **Mobile-first**: Most users will be on phones. All layouts, charts, and tables must be fully functional and readable on small screens. No horizontal scrolling. Charts reflow or simplify gracefully on narrow viewports.
- **Data presentation**: Every visualization has a plain-language headline that states the finding, not just the metric. "Il 23% degli appalti in Sicilia ha avuto un solo offerente", not "Single-bidder rate by region". Numbers are formatted Italian-style (1.234.567,89 EUR). Absolute amounts come with per-capita or percentage equivalents to make scale legible.
- **Progressive disclosure**: Show the key finding first, with the option to drill down. A user should understand the main point in 10 seconds without interacting. Filters, breakdowns, and raw data tables are available but secondary.
- **Source transparency**: Every data point has a visible, clickable link to its official government source. AI-generated narrative commentary is clearly labeled as such, with the data it was generated from cited inline. Nothing is presented as editorial opinion -- only as data with context.
- **Color and tone**: Serious and institutional, not alarmist. Restrained color palette. Red is reserved for genuinely anomalous values, never decorative. Should feel closer to a quality newspaper's data desk than to an activist website.
- **Search and discoverability**: Global search across municipality, contracting authority, company, CUP, and CIG codes. Primary entry point for users who arrive with a specific case in mind.
- **Performance**: Fast on mobile connections. Heavy data is paginated or loaded on demand. Visualizations render quickly with loading states that communicate progress, not just a spinner.
- **Accessibility**: Sufficient color contrast throughout. Charts are not the sole carrier of information -- key figures are also present as text. Keyboard navigable.
- **Language**: Italian throughout. Tone is neutral, factual, direct. Like a good data journalism outlet. No bureaucratic language, no jargon, no sensationalism.

## Explicitly not

- Not a research tool for data scientists, journalists, or academics. Those audiences have other tools; this one is for the general public.
- Not an activist website. Tone is institutional, not alarmist. No editorial opinion.
- Not a legal accusation engine. Anomaly flagging is statistical and framed as "pattern that warrants attention", never as a finding of wrongdoing.
- Not a primary data source. Every data point links back to the official government portal it came from. The platform aggregates and presents; it does not replace.
- Not a generic open-data browser. The five thematic sections are deliberately scoped to inefficiency, mismanagement, and waste of public funds. Other open-data uses are out of scope.

## History

- 2026-04-10: Scaffolded from web-project template. Initial brainstorm captured above, including UI/UX principles and the nine core data sources (ANAC/BDNCP, OpenCoesione, OpenCUP, MIT Anagrafe Opere Incompiute, MEF/RGS BDAP, SoldiPubblici, ISTAT, Parlamento Italiano, Corte dei Conti).
