# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## Project

**fixitalia** -- Civic tech platform that aggregates Italian public administration open data into clear, plain-language visualizations focused on inefficiency, mismanagement, and waste of public funds.

Consult `project-kb/` for topic-specific notes on bugs, features, and architectural decisions. The `project-kb/Overview.md` file captures the initial brainstorming that shaped this project.

## Stack at a glance

- **Frontend**: Vite 7 + React 19 + TypeScript (strict), React Router 7, Tailwind v4 + shadcn/ui (`radix-nova` style). Source under `src/`.
- **Backend**: Express 5 + TypeScript (via `tsx`). Source under `server/`. Exposes `/api/*`.
- **Data**: SurrealDB v2.1.4 sidecar (rocksdb storage, bind-mounted at `./server/data/surreal`). Reachable inside the compose network as `fixitalia-surrealdb:8000`.
- **CI**: GitHub Actions, via thin caller stubs that reference reusable workflows at `TheR4iner/reusable-workflows@v1`. `ci.yml` runs CI (lint/type/test/build) on push/PR to `main` and `develop` but does **not** publish. `release.yml` publishes the `ghcr.io/TheR4iner/fixitalia-{frontend,backend}` images and deploys to the VPS on `v*` tags -- the only path that publishes or deploys.
- **Testing**: Vitest + Testing Library (frontend and backend). Happy DOM as the test environment.

## Development environment

Two watchers and two datastores. Start the datastores with Docker, then run the
watchers directly:

```bash
docker run -d --name fixitalia-surrealdb -p 8000:8000 \
  -v fixitalia-surreal:/data surrealdb/surrealdb:v2.6.5 \
  start --user root --pass root rocksdb:/data/db

docker run -d --name fixitalia-meili -p 7700:7700 \
  -v fixitalia-meili:/meili_data getmeili/meilisearch:v1.11 \
  meilisearch --master-key devkey
```

The backend's defaults target container hostnames, so a local run needs
`server/.env` with `SURREALDB_URL=http://localhost:8000/rpc`,
`SURREAL_USER`/`SURREAL_PASS`, `MEILI_URL=http://localhost:7700` and
`MEILI_MASTER_KEY`. See the README for the full file.

```bash
npm install && npm run dev                  # frontend, http://localhost:5173
cd server && npm install && npm run dev     # backend,  http://localhost:3001
```

Vite proxies `/api` to the backend, so browse via the frontend port. Both
watchers reload on save; neither needs a build step first.

A fresh database is empty and every page renders its "no data" state until you
ingest something:

```bash
cd server && npx tsx scripts/ingest.ts --help
```

The full parliamentary corpus takes hours and hits upstream rate limits. Start
with `appalti` or `opere-incompiute` for a working site.

> **Note on the maintainer's setup.** Day-to-day development happens inside a
> sandboxed container that also hosts a coding agent, with its own process
> supervisor. That tooling is specific to one machine and is deliberately not
> tracked in this repository, so the older instructions referring to a
> `workspace` helper or a `dev` CLI do not apply here. The commands above are
> the supported path.

## Directory layout

```
.
├── Dockerfile                   # Prod frontend: Vite build -> extractor image
├── index.html                   # Vite entry HTML
├── package.json                 # Frontend deps + scripts
├── components.json              # shadcn/ui CLI config (radix-nova style)
├── tsconfig.json                # Frontend TS config (strict: true)
├── vite.config.ts               # Vite + Vitest config, /api proxy, tailwind plugin
├── eslint.config.js             # Flat-config ESLint
├── public/                      # Static assets copied to dist/
├── src/
│   ├── main.tsx                 # App entry (providers + router)
│   ├── App.tsx                  # Route definitions
│   ├── index.css                # Tailwind v4 + shadcn tokens + @theme inline
│   ├── i18n/it.ts               # Every user-facing string, Italian only
│   ├── components/ui/           # shadcn/ui primitives
│   ├── hooks/                   # Custom hooks
│   ├── contexts/                # React Context providers
│   ├── services/                # API clients / external service wrappers
│   ├── utils/                   # Pure helpers
│   ├── lib/utils.ts             # cn() -- shadcn class-merge helper
│   ├── pages/                   # Route-level components
│   └── test/setup.ts            # Vitest setup (jest-dom matchers)
├── server/
│   ├── package.json             # Backend deps + scripts
│   ├── tsconfig.json            # Backend TS config (strict: true)
│   ├── Dockerfile               # Prod backend image
│   ├── server.ts                # Express entry (helmet, cors, routes, shutdown)
│   ├── routes/                  # Route modules (one file per resource)
│   ├── lib/                     # DB helpers, ingest pipelines, SurrealDB client
│   ├── scripts/                 # Ingest CLI and one-off probes
│   ├── data/                    # Persisted files -- gitignored
│   └── test/                    # Backend tests
├── .github/workflows/           # Thin caller stubs for shared reusable workflows
└── project-kb/                  # Long-lived notes per topic (see below)
```

Deployment compose files, the sandbox image, and the process supervisor are
specific to the maintainer's machine and are not tracked here.

## Styling: Tailwind v4 + shadcn/ui

**Tailwind v4 uses a CSS-first config.** There is NO `tailwind.config.js`. All design tokens live in `src/index.css` under `:root`, `.dark`, and the `@theme inline` block. To add or tweak a design token, edit that file. The `@tailwindcss/vite` plugin picks up changes on the next HMR cycle.

**shadcn/ui primitives live under `src/components/ui/`.** To add more primitives, use the CLI:

```bash
npx shadcn@latest add card dialog input
```

The CLI reads `components.json` at the repo root, installs any missing Radix dependencies, and writes the generated component into `src/components/ui/`. Never paste shadcn components from a web search -- always use the CLI so the versions stay in sync with your Tailwind + Radix baselines.

**Composition pattern.** Every UI primitive accepts `className` and is composed with `cn()` from `@/lib/utils`. Build feature components on top of primitives; keep primitives unmodified so upgrades via the CLI remain clean.

```tsx
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

<Button className={cn('w-full', isDanger && 'bg-destructive')}>Save</Button>
```

**Dark mode.** The `.dark` class on `document.documentElement` flips the token set; the resolution lives in `src/hooks/useTheme.ts` (with a pre-paint snippet in `index.html` to avoid a light-to-dark flash on first render). User choice persists in `localStorage` under `fixitalia.theme`.

**Design principles** (apply to every feature you add):

- Mobile-first: start with the smallest layout, then widen via `sm:`, `md:`, `lg:` breakpoints.
- Use semantic HTML (`main`, `header`, `nav`, `section`, `article`) before reaching for `div`.
- Respect the token system: `bg-background`, `text-foreground`, `border-border`, `text-muted-foreground`. Avoid raw `text-gray-500` style classes.
- Keep hit targets at least `size-9` (36px) on touch devices.
- Animate with Tailwind utilities or `tw-animate-css` classes; avoid ad-hoc keyframes.
- Every interactive element must have a visible `:focus-visible` ring (already baked into `Button`).

## Path aliases

Imports can use the `@/` alias configured in both `tsconfig.json` and `vite.config.ts`:

```ts
import { MyComponent } from '@/components/MyComponent'
import { useAuth } from '@/hooks/useAuth'
```

## Commands reference

```bash
# --- Run ---
npm run dev                            # frontend watcher
(cd server && npm run dev)             # backend watcher

# --- Build & verify ---
npm run build                          # Type check + Vite production build
npm run lint                           # ESLint (flat config)
npx tsc --noEmit                       # Standalone TS type check
npm run test:run                       # Frontend vitest, single run
(cd server && npm run test:run)        # Backend vitest, single run
(cd server && npm run type-check)      # Backend tsc

# --- Data ---
(cd server && npx tsx scripts/ingest.ts --help)
```

## project-kb convention

Every topic worth remembering (a specific bug, a feature, an architectural decision, a recurring issue) gets **one file** under `project-kb/`. The rule is one file per topic, not one file per session. When new work relates to an existing topic, append to its file; never create duplicates.

Before starting any task, silently search `project-kb/` for relevant prior context. After completing meaningful work, update or create the relevant note.

File structure inside each note: `## Overview`, `## Current solution`, `## Open questions`, `## History` (prepend new entries so the most recent work is at the top).

### Public notes vs `project-kb/private/`

This repo is intended to go open source, and `project-kb/` is meant to go public
with it: the notes are how a contributor (or another Claude Code session) learns
the data-source quirks, the ingest patterns, and the bugs already solved.

Split by **audience**, not by sensitivity:

- **`project-kb/*.md` -- public, the default.** Contributor knowledge: how the
  code works, why a data source behaves the way it does, what a past bug was and
  how it was fixed, coverage audits.
- **`project-kb/private/` -- gitignored, never committed.** Operator knowledge
  tied to the owner's own machines: deploy topology and hostnames, secrets
  layout, the ingest apparatus (exit-pool naming, rotation cadence, the chunk
  sizes that stay under an upstream WAF's limits).

The test when writing a note: *would this still be true and useful for someone
who forked the repo and deployed it themselves?* If yes it is public; if it only
makes sense against this owner's box, it goes in `private/`.

Stating that Senato sits behind an AWS WAF and needs the Playwright path is
public context. Publishing the operational recipe for staying under its ban
threshold is not: it reads as a circumvention manual and is the single piece of
this repo with real legal exposure.

## CI / CD

All workflows are thin caller stubs that reference reusable workflows in the private repo `TheR4iner/reusable-workflows@v1`. The actual CI logic lives there; updating it once benefits every project.

- **On push/PR** to `main` or `develop`: `ci.yml` calls `web-ci.yml` (frontend + backend lint, type-check, test, build). Both must pass. `ci.yml` does **not** publish images -- pushing to `main` builds and verifies only.
- **On `v*` tag push**: `release.yml` calls `web-docker-publish.yml` and publishes the images to `ghcr.io/TheR4iner/fixitalia-{frontend,backend}` -- semver tags (`{major}`, `{major}.{minor}`, `{version}`), a short-SHA tag, and `latest` -- then runs the `deploy` job (syncs SurrealDB credentials to the VPS, then SSHes in to pull + restart). Tagging is the only path that publishes images or deploys. Create release tags with `git tag v1.2.3 && git push --tags`.
- **Weekly (Mondays 09:00 UTC) and on push/PR**: `security.yml` calls `web-security.yml` (`npm audit` + license check).

**One-time setup**: the `reusable-workflows` repo is private. For this caller to access it, the shared repo's *Settings -> Actions -> General -> Access* must be set to *"Accessible from repositories owned by the user TheR4iner"*. This is a per-shared-repo setting, configured once and benefits all callers.

To pick up CI improvements pushed to `reusable-workflows`, no action is needed; `@v1` floats and auto-updates on non-breaking releases. To pin to an exact version, change `@v1` to `@v1.2.3` in the caller files.

To trigger a release:

```bash
git checkout main
git pull
git tag v0.1.0
git push origin v0.1.0
```

## Deploying to production

The production stack is the Express backend, SurrealDB, Meilisearch, and a
one-shot image that copies the built SPA into a shared volume for a Caddy that
lives outside this repository. The compose file, the env files, and the server
configuration are specific to the maintainer's box and are not tracked here.

A release is `git tag vX.Y.Z && git push origin vX.Y.Z`, which publishes the
images and triggers a redeploy. Merging to `main` runs CI only.

## Italian-specific considerations

These were flagged at scaffold time and should shape early architectural decisions. Re-read before touching number formatting, entity models, or the Corte dei Conti ingestion path.

### Number, currency, and date formatting

Italian formatting is the *opposite* of the JavaScript locale default: thousands separator is `.`, decimal separator is `,`, currency is suffixed (`1.234.567,89 EUR`). Never roll your own formatter. Use the platform `Intl` APIs with the `it-IT` locale:

```ts
const eur = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' })
const num = new Intl.NumberFormat('it-IT')
const date = new Intl.DateTimeFormat('it-IT', { dateStyle: 'long' })

eur.format(1234567.89)   // "1.234.567,89 EUR"
num.format(1234567.89)   // "1.234.567,89"
date.format(new Date())  // "10 aprile 2026"
```

Set `lang="it"` on the root `<html>` element so screen readers, browser autotranslate heuristics, and CSS `:lang(it)` selectors all behave correctly. The brainstorm calls for plain-language headlines that state the *finding*, not the metric -- formatting consistency is half of that promise.

### Entity model: ISTAT codes are the join key

Italian regional, provincial, and municipal data is keyed by **ISTAT codice comune** (and provincial / regional codes for higher levels of aggregation). Place names are unreliable as join keys: encoding variations (San Donà di Piave vs. San Dona' di Piave), historical merges (fusioni di comuni), and inconsistent capitalization across sources will create spurious mismatches.

When ingesting from ANAC, OpenCoesione, OpenCUP, MIT, MEF/RGS, SoldiPubblici, ISTAT, etc.:
- Persist the ISTAT code on every row that has a geographic dimension.
- Use the code as the foreign key for joins, never the place-name string.
- Keep the human-readable name as a separate display field, sourced canonically from ISTAT.
- Plan for the codice comune to change over time (fusioni, scissioni). Track effective-from and effective-to dates if cross-period analysis is in scope.

Designing the entity model around codes from day one avoids a future where every cross-source query is doing fuzzy string matching.

### Corte dei Conti PDFs are a separate phase

Corte dei Conti referti are published as **PDF documents** with no machine-readable bulk feed. Extracting structured findings requires text extraction *and* LLM-assisted parsing, both of which are slow, error-prone, expensive, and impossible to validate without domain expertise. This is the highest-risk ingestion source by a wide margin.

Treat Corte dei Conti as a **post-MVP phase**. The MVP should ship without it. Designing the rest of the platform on the assumption that audit findings will arrive later (as a separate ingest with its own table and a join key back to the entity it audits) keeps the critical path clean.

### Project description language

The current `PROJECT_DESCRIPTION` (used in `README.md`, `package.json`, `index.html` meta tag, and this `CLAUDE.md`) was generated in English at scaffold time. The audience is Italian, so any user-visible surface should be translated before going live. Locations to update when you swap it:

- `README.md` (title block / first paragraph)
- `package.json` (`description` field)
- `index.html` (`<meta name="description">` and `<title>`)
- `src/App.tsx` (the `PROJECT_DESCRIPTION` constant rendered as the home page tagline)
- `CLAUDE.md` (this file, top "Project" section)

`project-kb/Overview.md` can stay in English -- it is internal documentation, not a user-facing surface.

## How to operate -- VERY IMPORTANT

- Keep the code professional, modular, and efficient. Prefer small, focused modules over sprawling files.
- Do not overcomplicate. Troubleshooting usually needs a simple fix, not hundreds of lines of new code.
- Do not reimplement features that an existing, well-maintained library already provides.
- **Fix errors on sight**: if you encounter clear programming errors, logic bugs, design issues, or linting errors while working on any task, always fix them immediately, even if unrelated to your current task.
- Report big problems (architectural issues, security vulnerabilities, data loss risks) even if your task was unrelated.
- Never commit any `.env` file or anything under `server/data/`. Check `.gitignore` if unsure.
- Never include AI attribution in commits or PRs. No "Co-Authored-By: Claude" lines, no mention of Claude/AI in commit messages, no AI references in PR descriptions.
- Before committing, verify the backend is healthy: `curl -fsS http://localhost:3001/api/health`.
