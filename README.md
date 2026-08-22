# fixitalia

**I dati pubblici italiani, finalmente leggibili.**

La pubblica amministrazione italiana è obbligata per legge a pubblicare i propri
dati, e lo fa: appalti, opere incompiute, fondi europei, spesa dello Stato,
attività parlamentare. Il problema è che li pubblica in decine di portali
diversi, in CSV grezzi, XML, PDF e RDF, in una forma che è tecnicamente aperta e
praticamente illeggibile.

fixitalia importa quei dati, li mette in relazione e li racconta in italiano
comprensibile, con la fonte originale sempre a un clic di distanza. Non accusa
nessuno: mostra schemi statistici nei numeri ufficiali e lascia le conclusioni a
chi legge.

> The rest of this README is in English, as the working language of the
> codebase. The application itself is Italian-only by design.

---

## What this is

A civic-tech platform that ingests Italian public-administration open data and
presents it as plain-language visualisations. Five data sections (public
procurement, unfinished public works, EU cohesion funds, state spending,
parliamentary activity) plus a personal-tax simulator, all sourced from official
portals with per-figure attribution.

The parliamentary section is the largest piece: roughly 9,800 sittings across
both chambers, with speakers, votes and full-text search over the transcripts.

## Stack

| Layer | Choice |
|---|---|
| Frontend | Vite 7, React 19, TypeScript (strict), React Router 7, Tailwind v4, shadcn/ui |
| Backend | Express 5, TypeScript via `tsx` |
| Data | SurrealDB (rocksdb), Meilisearch for full-text |
| Ingest | Scheduled TypeScript jobs; Playwright where a source needs a real browser |
| Tests | Vitest with Testing Library, Happy DOM |
| CI/CD | GitHub Actions calling shared reusable workflows; images to GHCR on `v*` tags |

## Running it locally

You need Node 22 or newer, and Docker for the two datastores. There is no build
step to run first: both watchers compile on the fly.

**1. Start SurrealDB and Meilisearch.**

```bash
docker run -d --name fixitalia-surrealdb -p 8000:8000 \
  -v fixitalia-surreal:/data surrealdb/surrealdb:v2.6.5 \
  start --user root --pass root rocksdb:/data/db

docker run -d --name fixitalia-meili -p 7700:7700 \
  -v fixitalia-meili:/meili_data getmeili/meilisearch:v1.11 \
  meilisearch --master-key devkey
```

**2. Point the backend at them.** The defaults target container hostnames, so a
local run needs `server/.env`:

```bash
SURREALDB_URL=http://localhost:8000/rpc
SURREAL_USER=root
SURREAL_PASS=root
MEILI_URL=http://localhost:7700
MEILI_MASTER_KEY=devkey
```

**3. Install and run.**

```bash
npm install
npm run dev                      # frontend on http://localhost:5173

cd server && npm install
npm run dev                      # backend on http://localhost:3001
```

Vite proxies `/api` to the backend, so use the frontend URL in the browser.

**4. Populate the database.** A fresh install starts empty, and every page will
show its "no data" state until you ingest something:

```bash
cd server && npx tsx scripts/ingest.ts --help
```

Ingesting the full parliamentary corpus takes hours and hits upstream rate
limits, so start with one of the smaller sections (`appalti`,
`opere-incompiute`) to get a working site.

### Checks

```bash
npm run lint                     # frontend ESLint
npx tsc --noEmit                 # frontend type check
npm run test:run                 # frontend tests
(cd server && npm run type-check && npm run test:run)
```

> The maintainer develops inside a sandboxed container that also hosts a coding
> agent. That tooling is specific to one machine and is not part of this
> repository; the instructions above are the supported path.

## Repository layout

See [CLAUDE.md](./CLAUDE.md) for the directory tour and the development
conventions, and [`project-kb/`](./project-kb) for topic notes accumulated while
building it: the data-source quirks, the bugs and how they were diagnosed, the
architectural decisions and what they cost. If you are picking up a piece of
this codebase, start there rather than with the source.

## Deployment

The deployment configuration is specific to the maintainer's server and is
not tracked here. The production stack is the Express backend,
SurrealDB, Meilisearch and a one-shot image that extracts the built SPA into a
shared volume. TLS and routing are handled by a shared edge Caddy that lives
outside this repository.

Releases are tag-driven:

```bash
git tag v0.1.0
git push origin v0.1.0
```

That publishes `latest`, `<version>`, `<major>.<minor>` and `<major>` tags for
both images, then triggers a redeploy.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Corrections to the data presentation,
new sources and bug reports are all welcome.

## Licence

Source code: [MIT](./LICENSE).

The data is **not** covered by that licence. It belongs to the public bodies
that publish it and carries its own terms, generally CC BY 4.0 or IODL 2.0,
which require attribution to the originating body. The site's "Fonti e licenze"
page lists every source, what it feeds and where its terms are published. If you
reuse a figure, cite the body that produced it, not fixitalia.

## Author

Built and maintained by Rolando Reiner as a personal, non-commercial project.
