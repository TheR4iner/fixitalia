# Dependency updates and Dependabot

## Overview

How dependency updates reach this repository, and the two traps that made the
first batch of them go badly.

The repository has two independent npm workspaces (`/` and `/server`) with
separate lockfiles, so every dependency question has to be answered twice.
Neither is a real npm workspace in the `workspaces:` sense: they are two
unrelated `package.json` files that happen to share a git repository, and
Dependabot treats them as two separate projects.

## Current solution

`.github/dependabot.yml` configures grouped weekly version updates for both
directories plus monthly `github-actions` updates, behind a `cooldown`.
`.github/workflows/dependabot-auto-merge.yml` waits for every check on the head
commit and squash-merges patch and minor bumps; the rest is labelled
`needs-review`. `.github/workflows/dependency-triage.yml` then reviews that pile
once a week.

The policy, in one table:

| Category | Policy |
|---|---|
| devDependencies, any semver level | auto-merge on green CI, 3-day cooldown |
| Runtime deps, patch and minor | auto-merge on green CI, 5 to 7-day cooldown |
| Runtime deps on the deny list | never auto-merge |
| Any major | never auto-merge, label `needs-review` |
| Security updates, non-major | auto-merge on green CI, no cooldown |

Two ideas do the work, and they are orthogonal. **CI protects against a broken
release. Cooldown protects against a malicious one.** Auto-merging with no
cooldown makes this repository's pipeline the fastest possible path from a
hijacked npm publish into `main`; a three to seven day quarantine turns almost
every historical npm supply-chain incident (event-stream 2018, ua-parser-js
2021, node-ipc 2022, the 2025 token-stealing worm) into a non-event, because
the malicious version was yanked within that window. Dependabot's `cooldown`
option applies to version updates only, which is right: a security update is
fixing something already public.

### Trap 4: the auto-merge job waited on itself

`gh pr checks --watch` waits for **every** check on the pull request, and the
auto-merge job is itself one of them. The first grouped pull request it was
supposed to merge (#18) sat with every real check green and `Auto-merge`
pending until the job hit its thirty-minute timeout, and nothing about the
symptom pointed at the cause.

The fix is `--required`, which watches only the checks branch protection
demands. That makes at least one required check a **prerequisite** for the
workflow rather than a nicety: with none configured, `--required` has nothing
to watch and exits non-zero. `main` currently requires `CI Success`.

The tidier alternative is `gh pr merge --auto`, which hands the wait to GitHub
and costs no runner minutes at all, but it needs "Allow auto-merge" enabled in
the repository settings. Worth switching to if that ever gets turned on.

A related note on branch protection, which was added to `main` while this was
being built: `required_conversation_resolution` is on, so every inline comment
the review workflow leaves must be resolved before a merge is possible. That is
usually what you want, but it does mean the review bot can block a merge, and
that resolving its threads is now part of the flow.

### Trap 5: `github.actor` is not the pull request author

Both workflows keyed their Dependabot test on `github.actor`. That is whoever
caused the specific event, not who opened the pull request, and the two differ
the moment a human touches a bot's pull request.

Reopening #18 by hand was enough to demonstrate both halves of it in one go:
the auto-merge job skipped, because the actor was no longer `dependabot[bot]`,
and the review job *ran*, buying a paid review of a twelve-package lockfile
diff for exactly the reason the guard was written to prevent. The same happens
on `ready_for_review`, or any other human-triggered event on a bot's pull
request.

Both now test `github.event.pull_request.user.login`, which is the author and
does not change with the event.

### The deny list, and why it is not about semver

`surrealdb`, `playwright`, `linkedom`, `csv-parse` and `express` never
auto-merge at any semver level.

Auto-merge delegates the merge decision to the test suite, so it is only as
honest as the suite. The frontend gate is genuinely good: 100 tests, `tsc`,
lint and a real production build, which a bad `react-router` or `recharts`
bump will fail. The backend gate is weaker than it looks. The 109 tests
exercise the ingest parsers against **captured fixtures**, not against live
Senato or Camera pages and not against a live SurrealDB. A `linkedom` release
that changes how it recovers from malformed markup, or a `surrealdb` client
release that changes a result shape, passes every check and breaks ingest
silently. That is the exact failure mode `claude-review.yml`'s prompt calls the
worst one here: a page that looks right and is wrong.

`xlsx` is pinned to a CDN tarball URL rather than a registry version, so
Dependabot cannot propose updates for it at all. It is not on the deny list
because it never reaches one.

### Where a model belongs, and where it does not

Not per pull request. A lockfile diff is thousands of lines of integrity
hashes, and a model reading it has strictly *less* information than the test
run does: it can guess whether `postcss` 8.5.26 breaks something, while CI
proves it. Paying for a guess at what a cheaper deterministic check already
settled is the wrong shape, independent of cost.

`dependency-triage.yml` places it where the economics invert: one scheduled
call a week over the `needs-review` pile, reading upstream changelogs and
migration guides and checking whether the breaking changes are reachable from
this codebase. That is comprehension over prose, which no test suite performs.
The other good placement is per incident rather than per pull request: when a
major breaks CI, hand a model the failing job and let it do the migration.

Because that job reads third-party release notes, its prompt states that pull
request bodies and changelogs are untrusted data. It is granted no tool that
writes anything except `gh pr comment`.

### Capping what the Claude workflows can spend

Runs are billed against a personal Claude subscription. There is no
per-repository spending cap for that on either side: GitHub Actions has no
notion of a token budget, and a subscription-billed run is not scoped to a
repository. The cap therefore has to be built, and it is built out of three
parts.

**`.github/actions/claude-budget`** is a local composite action that reads this
repository's own run history and refuses to start Claude past N invocations in
a trailing seven days: 20 for review, 3 for triage.

The subtlety is what it counts. Counting *workflow runs* is wrong in a way that
bites exactly once and then never recovers: a run blocked by the gate is still
a run, so a single week over the limit would push the count permanently above
the cap and the workflow would never start again. It therefore counts
*invocations*, by fetching the jobs of each past run and looking for a step
named `Run Claude` whose conclusion is not `skipped`. Runs that skipped Claude
cost nothing and consume nothing.

Two bugs found while writing it, both worth remembering:

- A failed `gh api --jq` writes the error body to **stdout**, so `2>/dev/null`
  does not suppress it and `|| true` happily passes it along. The 404 body
  reached `$(( used + n ))` as an operand. Every `gh api` call here now checks
  its exit status explicitly and discards the output on failure, and both the
  run ids and the count are validated as numeric before use.
- A 404 is the *normal* case on a workflow's first run, so it cannot be fatal.
  But a mistyped `workflow` input looks identical from inside the action and
  would silently grant an unlimited budget, so the failure path emits a
  `::warning::` rather than passing over it quietly.

**`--max-turns`** bounds a single invocation: 25 for review, 60 for triage,
which reads several changelogs per pull request. `timeout-minutes` bounds the
job around it.

**The review trigger** omits `synchronize`. That event fires on every push to a
pull request branch, so an afternoon of six pushes would buy six reviews of
substantially the same diff. Dropping it is the single largest saving here. The
cost is that a pull request rewritten after its review is not reviewed again
automatically; re-running the workflow from the Actions tab covers that.

Triage additionally caps itself at five pull requests per run and names in a
`::warning::` any it did not get to, so a backlog degrades visibly rather than
silently.

### Trap 1: security-only mode does not cover every manifest

Without `.github/dependabot.yml`, Dependabot still runs, but only in
security-updates mode: it reacts to alerts and does nothing on a schedule.

What that produced here, on 2026-08-22 when alerts were first switched on:
23 alerts appeared in the same second, and Dependabot dispatched exactly six
update jobs. All six were against `server/package-lock.json`. **Not one job was
ever created for the root `package-lock.json`**, so the frontend's ten
advisories, one of them GHSA-49rj-9fvp-4h2h (an unauthenticated RCE in the
`turbo-stream` deserializer vendored by React Router), were never attempted at
all. Dependabot then did not run again for three days.

```bash
# The evidence, if this needs re-checking later:
gh run list --workflow="Dependabot Updates" --limit 60 \
  --json displayTitle,conclusion,createdAt \
  --jq '.[] | [.createdAt, .conclusion, .displayTitle] | @tsv' | sort
```

GitHub does not document how many security-update jobs it will dispatch at
once. `open-pull-requests-limit` is not the answer: it defaults to 5 but
[applies to version updates only, and explicitly not to security
updates](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference).
The lesson is not a specific number, it is that **security-only mode is
best-effort per manifest and gives no signal when it skips one**. The alerts
page showed 23; the pull request list showed 5. Nothing reconciled the two.

Scheduled version updates fix this because they are driven by a cron over every
directory listed in the config, not by an alert dispatcher.

### Trap 2: Dependabot proposes majors for advisories a patch would fix

When the vulnerable package is a **transitive** dependency, Dependabot cannot
edit the lockfile entry in isolation. It walks up to the nearest direct
dependency and proposes its latest release.

That is how the August 2026 batch ended up proposing `vite` 8 and `vitest` 4
for advisories fixed in `vite@7.3.5` and `vitest@3.2.6`. Before accepting a
Dependabot major, check the advisory's own `first_patched_version`:

```bash
gh api repos/TheR4iner/fixitalia/dependabot/alerts \
  --jq '.[] | select(.state=="open")
        | [.dependency.manifest_path, .dependency.package.name,
           .security_advisory.severity,
           (.security_vulnerability.first_patched_version.identifier // "none")]
        | @tsv' | sort -u
```

If the patched version is within the current major, bump the direct dependency
to its latest patch or minor and run `npm audit fix`, which moves pinned
transitives inside their existing ranges. That resolved every advisory in both
workspaces without a single major upgrade.

### Trap 3: secrets are withheld from Dependabot runs

A workflow triggered by Dependabot on the `pull_request` event gets a
**read-only** `GITHUB_TOKEN` and **no repository secrets**. Any job that needs
either will fail on Dependabot pull requests and only on those, which reads as
a flaky check.

- `claude-review.yml` is therefore skipped for Dependabot, exactly as it is
  already skipped for forks.
- `dependabot-auto-merge.yml` runs on `pull_request_target`, which executes in
  the base repository's context with a writable token. That trigger is the
  standard way public repositories leak secrets **when the workflow checks out
  and runs the pull request's code**. This one never checks out anything. Do
  not add `actions/checkout` to it.

## Dependency hygiene found along the way

Two declared dependencies were pulling in advisories while serving no purpose:

- **`fast-xml-parser`** in `server/package.json`. Nothing in the repository
  imports it. It was the only reason the advisory requiring the 5.x major
  applied. Removed.
- **`shadcn`** in the frontend's `dependencies`, not `devDependencies`. It is
  the scaffolding CLI, invoked as `npx shadcn@latest add`, never imported by
  `src/`. It was dragging `hono`, `@hono/node-server`, `fast-uri`, `js-yaml`
  and `nanoid` into the *production* dependency tree, along with five
  advisories that `npm audit --production` in `security.yml` would report.
  Moved to `devDependencies` and bumped.

Worth re-checking whenever the advisory count jumps: an advisory in a package
nothing imports is a packaging bug, not a security problem.

## Open questions

- **`vite` 8 and `vitest` 4 are still pending.** No advisory requires them, so
  they were deliberately excluded from the security sweep. They are a real
  major upgrade: `vite` 8 wants `@vitejs/plugin-react` 6, and the frontend and
  backend should move together so the two test setups do not diverge.
- **No Claude secret is configured**, and `claude-review.yml` is currently
  `disabled_manually`. Both Claude workflows now skip cleanly instead of
  failing, and both accept either `ANTHROPIC_API_KEY` or
  `CLAUDE_CODE_OAUTH_TOKEN`, but neither does anything until one of those
  secrets exists and the review workflow is re-enabled with
  `gh workflow enable "Claude Review"`.
- **The Claude GitHub App is not installed, and does not need to be.** Both
  workflows pass `github_token: ${{ secrets.GITHUB_TOKEN }}`, which the
  action's FAQ gives as the way to run without it. Comments therefore arrive
  from `github-actions[bot]`, and `@claude` mentions do not work. Installing
  the app would fix both, at the price of granting it a broad permission set
  that GitHub does not let you narrow.
- **`security.yml` is advisory only.** Both jobs end in `|| true`, so a green
  check means the scan ran, not that it found nothing. Making the audit job
  fail on `high` and above would have caught the React Router advisory at the
  pull request that introduced it, at the cost of unrelated pull requests going
  red when an advisory is published overnight.

## History

### 2026-08-24 -- first dependency sweep, and the config that should prevent the next one

Dependabot had five open pull requests (#4, #5, #6, #7, #9, plus #8 already
closed), all against `server/package-lock.json`, all mutually conflicting
because they touch the same file. The frontend lockfile had ten advisories and
no pull requests at all.

Rather than merging them one at a time and rebasing four times, the whole thing
was redone as a single sweep in #12: direct dependencies bumped to their latest
patch or minor, `npm audit fix` run in both workspaces, the two unused
dependencies removed, and the five Dependabot pull requests closed as
superseded. Result: `found 0 vulnerabilities` in both workspaces, with lint,
type-check, 209 tests and the production build passing.

#13 added `.github/dependabot.yml` and `dependabot-auto-merge.yml`, fixed
`claude-review.yml` (which was failing on every pull request because
`ANTHROPIC_API_KEY` is unset and the action treats an empty key as an error),
and corrected the CI/CD section of `CLAUDE.md`, which still described the
workflows as thin caller stubs pointing at the private `reusable-workflows`
repository after they were vendored in #2.
