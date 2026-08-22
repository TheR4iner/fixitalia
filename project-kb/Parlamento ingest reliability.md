# Parlamento ingest reliability

## Overview

The daily auto-fetch silently stopped ingesting on **2026-07-16** and was not
noticed until **2026-08-16** -- a month of stale data on a page that advertises
itself as current. Nothing alerted, nothing looked wrong, and the container
reported `healthy` throughout.

This note is about why it was invisible, which matters more than the specific
trigger. Related: [[Parlamento read-path performance]], the maintainer's local operator notes, [[Parlamento body-pass atomicity]].

## The failure, and why nobody saw it

Three independent defects lined up so that a broken ingest was
indistinguishable from a healthy one.

### 1. Every failure path returned the same shape as success

`ingestParlamento` had five return paths. Four were failures (index pass threw,
browser would not launch, could not list pending sedute, catastrophic outer
catch) and every one of them returned an **all-zero** `IngestParlamentoResult`.

The scheduler then printed:

```
[scheduler] camera index +0, body ok=0 partial=0 empty=0 error=0 (0.0s)
```

which is byte-for-byte what a healthy run prints when parliament simply is not
sitting. In August, when the Italian Parliament is in recess and `+0` is the
*expected* result, the two are impossible to tell apart by eye.

The `(0.0s)` was the only tell: `durationMs: 0` is a literal in the failure
paths, whereas a real no-op run takes seconds. Nobody was looking at it.

### 2. The reconnect gave up after 8 milliseconds

Timestamps from the incident:

```
13:10:22.089  backend container starts
13:10:22.626  surrealdb container starts
13:10:30.484  [query] session expired, reconnecting and retrying once
13:10:30.492  INDEX PASS failed -- There was a problem with authentication
```

The first query fired **8 seconds** after start, into a SurrealDB that was
still opening a multi-GB RocksDB store, and got an auth error. `withDbRetry`
retried exactly once, **8ms later** -- far too fast for a datastore that needs
seconds -- and then propagated the error to a caller that swallowed it.

Note `depends_on: condition: service_healthy` was already set. It did not help:
`surreal is-ready` proves the HTTP port answers, not that the datastore is open
and the root user is usable. The healthcheck passes before the DB is actually
usable.

### 3. The health probe could not observe the failure

`/api/health` returned a static `200` and touched nothing. It was also the
Docker healthcheck. So the container reported `healthy` for 20 hours with a
dead database connection. A probe that never touches the DB cannot notice a
broken DB.

## Current solution

**Failures are now typed, not inferred.** `IngestParlamentoResult` carries
`ok: boolean` and `error?: string`. All five return paths set them. The
scheduler logs failures via `console.error` with a `FAILED` prefix plus one
loud summary line:

```
[scheduler] AUTO-FETCH DEGRADED: 1/2 chamber pass(es) failed (senato). Data may be stale...
```

Pinned by `server/lib/ingest/parlamento/result-contract.test.ts`, which asserts
the property that made this invisible: a caller must distinguish "found
nothing" from "blew up" without reading counters.

**Bounded same-day retry.** A failed run no longer waits a full day. It retries
up to 3 times, 30 minutes apart (`MAX_RETRIES_PER_DAY` / `RETRY_COOLDOWN_MS` in
`scheduler.ts`). The cooldown is deliberate: the Senato pass drives a real
browser against an AWS-WAF-protected site, so a tight retry loop risks a ban
that makes things worse. Simply clearing `lastRunDate` would have retried every
60 seconds -- that was the first thing tried and it is wrong.

**Reconnect with backoff.** `withDbRetry` now walks `[0, 500, 1500, 5000]ms`,
~7s total, re-resolving the client each attempt, and logs when it recovers and
when it gives up.

**Readiness split from liveness.** `/api/health` stays a static liveness probe.
New `/api/health/ready` runs `RETURN 1;` against SurrealDB and returns 503 when
it cannot. The prod Docker healthcheck points at `/ready`.

Caveat worth knowing: a failing Docker healthcheck marks a container
`unhealthy` but does **not** restart it -- `restart: unless-stopped` only acts
on exit. So `/ready` buys visibility, not auto-recovery. Auto-recovery comes
from the retry/backoff work above.

## Open questions

- **Why did the auth failure persist for 20 hours?** The startup race explains
  the first failure at 13:10:30. It does not explain why the run at 04:00 the
  next morning failed identically, since `withDbRetry` builds a fresh client on
  retry and the datastore was long since ready. Suspicion is a cached-but-
  unauthenticated client in the `db.ts` singleton, or a race between concurrent
  `resetDb()`/`getDb()` calls during a fan-out of failing queries. Not proven.
  The backoff work reduces the blast radius either way, and the loud logging
  means a recurrence will be visible within a day instead of a month.
- **Senato ingest from the VPS is WAF-blocked.** See below.

## History

### 2026-08-16 -- incident found and remediated

Found while verifying prod during the code-review pass. Prod was *already*
caught up (9,817 sedute, latest sitting 2026-08-07) because the backend had
been manually restarted at 09:54 that morning, which pulled +15 Camera and +11
Senato in one go. The month-long gap had self-healed by accident.

A manual `ingest.js parlamento --chamber both --legislatura 19` run confirmed:

- **Camera: `index +0`** after a real 335.6s pass -- genuinely nothing new
  (August recess). Deputati profile refresh: scraped=427, failed=21 (HTTP 403
  from camera.it on individual profile pages).
- **Senato: WAF BLOCK.** `warm-up did not capture aws-waf-token cookie`, and
  the run aborted immediately by design rather than prolonging the ban. Likely
  triggered by running a second Senato pass shortly after the 09:54 one. No
  data damage: DB unchanged at ok=9812 / empty=2 / error=2 / partial=1, total
  9,817. Senato sedute stay `!= "ok"` and resume on a later run.

The Senato WAF constraint is pre-existing (it volume-limits sustained
fetching, so backfills run in throttled resumable chunks);
the VPN pool is a local-machine facility, not something prod has. The practical
consequence is that prod's daily Senato pass is best-effort. With this change
that is at least now *visible* in the logs instead of silent.
