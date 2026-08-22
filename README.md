# fixitalia

**I dati pubblici italiani, finalmente leggibili.**

La pubblica amministrazione italiana è obbligata per legge a pubblicare i propri
dati, e lo fa: appalti, opere incompiute, fondi europei, spesa dello Stato,
attività parlamentare. Ma li pubblica in decine di portali diversi, in CSV
grezzi, XML, PDF e RDF: tecnicamente aperti, praticamente illeggibili.

fixitalia importa quei dati, li mette in relazione e li racconta in italiano
comprensibile, con la fonte originale sempre a un clic di distanza. Non accusa
nessuno: mostra schemi statistici nei numeri ufficiali e lascia le conclusioni a
chi legge.

Cinque sezioni di dati più un simulatore fiscale. La più grande è il Parlamento:
circa 9.800 sedute delle due camere, con oratori, voti e ricerca full-text sui
resoconti.

> Il sito è in italiano; il resto di questo README è in inglese, la lingua di
> lavoro del codice.

## Stack

Vite 7, React 19 and TypeScript (strict) on the front, with Tailwind v4 and
shadcn/ui. Express 5 on the back. SurrealDB for storage, Meilisearch for
full-text. Ingest is scheduled TypeScript jobs, using Playwright where a source
needs a real browser. Vitest throughout.

## Running it locally

Node 22+ and Docker. No build step first; both watchers compile on the fly.

```bash
# 1. Datastores
docker run -d --name fixitalia-surrealdb -p 8000:8000 \
  -v fixitalia-surreal:/data surrealdb/surrealdb:v2.6.5 \
  start --user root --pass root rocksdb:/data/db

docker run -d --name fixitalia-meili -p 7700:7700 \
  -v fixitalia-meili:/meili_data getmeili/meilisearch:v1.11 \
  meilisearch --master-key devkey

# 2. server/.env -- the defaults target container hostnames, so this is required
cat > server/.env <<'EOF'
SURREALDB_URL=http://localhost:8000/rpc
SURREAL_USER=root
SURREAL_PASS=root
MEILI_URL=http://localhost:7700
MEILI_MASTER_KEY=devkey
EOF

# 3. Run
npm install && npm run dev                   # http://localhost:5173
cd server && npm install && npm run dev      # http://localhost:3001
```

Browse via the frontend port; Vite proxies `/api` to the backend.

A fresh database is empty and every page shows its "no data" state until you
ingest something. Start with a small section, since the parliamentary corpus
takes hours and hits upstream rate limits:

```bash
cd server && npx tsx scripts/ingest.ts --help
```

Checks: `npm run lint`, `npx tsc --noEmit`, `npm run test:run`, and
`npm run type-check && npm run test:run` in `server/`.

Deployment config is specific to the maintainer's server and is not tracked
here. Releases are tag-driven: `git tag vX.Y.Z && git push origin vX.Y.Z`
publishes the images and triggers a redeploy.

## Where to start reading

[CLAUDE.md](./CLAUDE.md) has the directory tour and the conventions.
[`project-kb/`](./project-kb) has a note per topic, accumulated while building:
data-source quirks, bugs and how they were diagnosed, decisions and what they
cost. If you are picking up part of this codebase, start there rather than with
the source.

Contributions welcome, especially corrections to the data:
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Licence

Source code: [MIT](./LICENSE).

**The data is not covered by that licence.** It belongs to the public bodies
that publish it and carries its own terms, generally CC BY 4.0 or IODL 2.0,
which require attribution to the originating body. The site's "Fonti e licenze"
page lists every source and where its terms are published. If you reuse a
figure, cite the body that produced it, not fixitalia.

Built and maintained by Rolando Reiner as a personal, non-commercial project.
