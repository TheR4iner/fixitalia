# UI foundation

## Overview

First pass at the React UI shell: Tailwind v4 + shadcn (Nova preset, neutral
base, CSS variables), Italian-first layout and copy, five thematic section
routes matching the brainstorm in `Overview.md`, and one proof-of-pattern
prototype page (`Appalti`) with real shadcn Chart + Table composition using
mock data. Built on branch `feat/ui-foundation` cut from `develop`.

Key decisions and why:

- **Italian strings live in `src/i18n/it.ts`**, not inline. Single dictionary,
  `as const` for literal inference. The project is Italian-first; there is no
  English fallback. Every future component must pull its copy from here.
- **Number/date formatting lives in `src/lib/format.ts`**. One set of cached
  `Intl` instances (it-IT) for EUR, number, percent, date. Never hand-roll
  Italian number formatting anywhere -- the thousands separator is `.` and the
  decimal is `,`, which is the opposite of JavaScript's default locale.
- **`formatPercent` takes a raw fraction (0.23), not 23.** Statistical data is
  stored as ratios and piped straight through to `Intl.NumberFormat`.
- **`StubPage` shared component** backs the four coming-soon sections
  (`OpereIncompiute`, `FondiEuropei`, `SpesaPubblica`, `Parlamento`). Each
  section's own `*.tsx` is a one-liner. When a section grows its own content,
  replace the one-liner in place.
- **`AppaltiPage` is the pattern template.** KPI Cards -> ChartContainer bar
  chart -> shadcn Table. All mock data is clearly marked with comments so it
  can be swapped for real ANAC data ingestion without restructuring the page.
- **Chart colour via `ChartContainer` config + `var(--color-<key>)`.** The
  bar `fill` is `var(--color-monofornitori)` which the container emits from
  its config. No inline hex; keeps colour decisions anchored to theme tokens.
- **Mobile-first nav.** Full nav + search in header on `md`/`lg`; below that,
  a hamburger button opens a shadcn Sheet drawer with the same links. The
  search input is also pinned as a secondary row on mobile so it is always
  visible.
- **Backend health** is shown as a subdued dot + label at the bottom of the
  home page via `useBackendHealth` (moved from the old template `App.tsx`).

## Current solution

Routes wired in `src/App.tsx`:

- `/` -> `HomePage` (hero, search, 5 section cards, health dot)
- `/appalti` -> `AppaltiPage` (full prototype)
- `/opere-incompiute`, `/fondi-europei`, `/spesa-pubblica`, `/parlamento`
  -> `StubPage` with the section's description and a `Prossimamente` card

Layout wraps all routes. `index.html` has `lang="it"`, Italian `<title>`, and
an Italian meta description.

## Open questions

- Global search is wired but just navigates to `/?q=...`. Needs a real
  search backend + results UI in a follow-up.
- Dark mode: tokens are in `index.css` but there is no toggle yet.
- The `HeroSearch` and `Layout` `SearchForm` duplicate logic. Fine for now
  since they have different layouts, but if a third search surface shows up
  factor out a shared hook.

## History

- **2026-08-16** -- Added `/contatti` (`src/pages/ContattiPage.tsx`), a static
  about/contact page: author name, a statement that fixitalia is an unfunded
  personal side project, the automated-ingest caveat, and a LinkedIn link.
  Copy lives under `t.contatti` in `i18n/it.ts`, deliberately *outside*
  `t.sections` because `HomePage` renders that map as the grid of data
  sections and Contatti is not a dataset. It is still the last entry of
  `NAV_ITEMS` in `Layout`, so it shows in the header (and mobile Sheet) to the
  right of "Le tue tasse" -- the only non-dataset link in the primary nav.
  Note lucide-react ships no brand icons, so the LinkedIn link
  uses the `ExternalLink` glyph like every other off-site link.
- **2026-04-10** -- Initial UI foundation scaffolded on `feat/ui-foundation`
  from `develop`. Delivers: Italian Intl helpers, `i18n/it.ts` dictionary,
  `Layout` with mobile Sheet nav, `HomePage` with hero + section grid,
  `AppaltiPage` prototype with a 20-region horizontal bar chart and a table
  of contracts, four stub pages, routes under `Layout`. All mock data in
  `AppaltiPage` is clearly labelled; swap for real ANAC ingestion later.
