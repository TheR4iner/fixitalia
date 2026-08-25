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
directories plus monthly `github-actions` updates.
`.github/workflows/dependabot-auto-merge.yml` waits for every check on the head
commit and squash-merges patch and minor bumps; anything carrying a major bump
is labelled `needs-review` and left for a human.

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
- **`ANTHROPIC_API_KEY` is not configured**, and `claude-review.yml` is
  currently `disabled_manually`. The workflow now skips cleanly instead of
  failing when the key is absent, so it can be re-enabled safely, but it will
  do nothing until the secret is set.
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
