# Contributing

fixitalia is maintained by one person in their spare time. Contributions are
welcome; a slow response is likely, and is not a judgement on the contribution.

By taking part you agree to the [code of conduct](./CODE_OF_CONDUCT.md). For
security reports, see [SECURITY.md](./SECURITY.md) rather than opening an issue.

## The most valuable contribution

**A wrong number.** Every figure on the site links to the portal it came from.
If a figure disagrees with its source, that is a bug worth reporting above
anything else, and the report only needs three things: the page, the figure, and
the source value it should match.

Ingest bugs are quiet by nature. A parser that silently extracts zero rows
leaves a page that looks fine and is simply wrong, so an outside reader noticing
a discrepancy is often the only signal there is.

## Ground rules for the copy

The project describes patterns in official data. It does not allege wrongdoing.
Please keep new copy inside that line: "spesa cresciuta del 40% in tre anni" is
the register, "sprechi del comune di X" is not, however tempting the data makes
it. The distinction is legal as well as editorial.

All user-facing text is Italian, and lives in `src/i18n/it.ts` rather than
inline in components. There is no English fallback on purpose.

## Before opening a pull request

Work happens on feature branches merged into `develop`; `main` tracks what is
deployed. Run the same checks CI does:

```bash
npm run lint
npx tsc --noEmit
npm run test:run
(cd server && npm run type-check && npm run test:run)
```

Then open the PR against `develop`.

## Adding a data source

New sections are welcome, but a source is a long-term commitment: it has to be
re-ingested, it will change format without warning, and it will eventually break
in a way nobody notices. Before writing the ingest, please open an issue
covering:

- the portal, the dataset and its licence (attribution terms matter here, see
  the site's "Fonti e licenze" page);
- whether rows carry an ISTAT code. Place names are not usable as join keys:
  spelling variants, historical mergers and inconsistent capitalisation across
  sources create silent mismatches, so anything with a geographic dimension
  needs the code;
- what the section would actually tell a reader. A dataset that produces a chart
  nobody can interpret is not a section.

`project-kb/Data ingestion pattern.md` documents the shape existing ingests
follow.

## Scraping etiquette

Some sources are bulk APIs and some are HTML. For the HTML ones, keep requests
throttled and resumable, and honour whatever the source asks of automated
clients. Do not add code that works around a rate limit, a WAF, or any other
access control a source has deliberately put in place. A slow ingest is fine;
this project has no deadline.

## Code conventions

`CLAUDE.md` carries the full set. The short version: strict TypeScript with no
escape hatches, Tailwind design tokens rather than raw colour classes,
mobile-first layouts, shadcn/ui primitives added through the CLI and left
unmodified, and a visible focus ring on everything interactive.
