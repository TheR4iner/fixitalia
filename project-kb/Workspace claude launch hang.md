## Overview

`./workspace claude` would hang silently with no output. Repeated attempts left dead claude processes inside the workspace container.

There were actually **two stacked root causes**, found in sequence. Don't stop after the first one when re-investigating.

## Root cause #1: stale npm CDN IPs in the egress firewall (the dominant blocker)

`init-firewall.sh` resolves a fixed list of allowed domains at container boot via `dig`, snapshots the resulting IPv4 addresses into an ipset, and pins them. `registry.npmjs.org` lives behind Cloudflare's CDN, which rotates its anycast IPs on a timescale of hours-to-days. Hours after boot, the live DNS answer no longer overlaps the pinned ipset, and outbound TCP to npm dies (SYNs dropped, no RST -- the symptom is a connection hang, not a refusal).

claude's TUI runs `npm view @anthropic-ai/claude-code@latest version` synchronously at startup as a self-update probe. With npm registry unreachable, that probe hangs indefinitely, and claude never reaches the point where it renders its banner. From the host side it looks like nothing happened.

You can see the staleness directly: compare boot-time firewall logs (`docker logs fixitalia-workspace-1 | grep registry.npmjs.org`) against the live `getent hosts registry.npmjs.org` from inside the container -- the two sets disagree.

## Root cause #2: Docker Compose 5.x flipped `--no-tty` to default true

Independently, Docker Compose 5.1.3 (paired with Docker Engine 29.4.0) changed the default of `docker compose exec --no-tty` to `true`, and the `exec` subcommand no longer exposes a `-t/--tty` flag to opt back in. Help text is contradictory ("By default ... allocates a TTY" while `(default true)` is shown for `--no-tty`).

This was *not* the cause of the current hang -- TUI processes did receive a TTY in our reproduction -- but it's a latent footgun for any future invocation that relies on TTY allocation defaults. Worth fixing while we're here.

## Current solution

Two changes plus one re-init:

1. `docker-compose.yml` -- workspace service env now sets `DISABLE_AUTOUPDATER: "1"`. claude no longer makes the npm registry probe at startup, so its launch is independent of CDN reachability. The image's pinned version is the source of truth; updates happen on `./workspace up --build`, not via in-process self-update.

2. `./workspace` -- the `claude`, `attach`, and `exec` cases use `docker exec -it $(docker compose ps -q workspace) ...` instead of `docker compose exec`. The lower-level `docker exec` still has functioning `-i` and `-t` flags. The `claude` path also `pkill`s any orphaned `claude --dangerously-skip-permissions` inside the container before launching, so a leftover from a previously-broken session can't block a new one.

3. To recover an already-broken container without rebuilding: `docker compose up -d --no-deps workspace` recreates just the workspace container, which re-runs `init-firewall.sh` from a clean kernel state and re-pins fresh CDN IPs. Do **not** try to re-run `init-firewall.sh` inside a running container -- it `iptables -F`s but doesn't reset chain policies, so the in-flight curl to `api.github.com/meta` is dropped by the still-DROP OUTPUT policy and the script wedges (verified during the 2026-05-04 debug session).

## Open questions / follow-ups

- **Harden `init-firewall.sh` to reset chain policies before flush** so it can be re-run inside a live container: add `iptables -P INPUT ACCEPT; iptables -P OUTPUT ACCEPT; iptables -P FORWARD ACCEPT` at the top, before `iptables -F`. This would let the script self-heal without a container restart.
- **Widen the npm registry allowlist to a CIDR range** rather than snapshotted /32s -- e.g. allow 104.16.0.0/13 (Cloudflare's primary range) so CDN IP rotation doesn't drift the allowlist out of date. Same applies to other CDN-fronted endpoints.
- **Compose `--tty` regression**: track upstream. If a future Compose release re-introduces `-t` or restores the old default, the workspace script can go back to `docker compose exec` for symmetry with other base-project repos.
- **PID 1 zombie reaping**: the `[node] <defunct>` zombies parented to PID 1 inside the workspace container only clear with a recreate. Consider `init: true` in compose (tini as PID 1) so zombies are reaped automatically.

## History

### 2026-05-04 -- second debugging session (npm probe hang)

- Symptom recurred. `ps` from host showed an in-container `claude --dangerously-skip-permissions` with a child `npm view @anthropic-ai/claude-code@latest version` running for minutes. `do_epoll_wait` from the prior session was on past instances; the current one was stuck *before* startup, in the update probe.
- `curl -4` and `curl -6` to `https://registry.npmjs.org/` from inside the container both timed out. `getent hosts registry.npmjs.org` returned only IPv6 anycast addresses (`2606:4700::6810:xxx`); boot-time firewall logs had pinned only IPv4 addresses (`104.16.x.34`). CDN IP rotation drift confirmed.
- Tried re-running `init-firewall.sh` in place; it wedged at "Fetching GitHub IP ranges..." because `iptables -F` had wiped specific ACCEPT rules but the `OUTPUT DROP` policy persisted, killing the script's own outbound API call.
- Recovery path: `docker compose up -d --no-deps workspace` recreated the workspace, which re-ran the firewall from a clean policy-ACCEPT state. After that, `npm view` returned in normal time and the new fresh IP (`104.16.0.34`) was visible in logs.
- Added `DISABLE_AUTOUPDATER: "1"` to the workspace env in `docker-compose.yml` as the durable fix so future CDN-rotation episodes don't reproduce the symptom.

### 2026-05-04 -- first debugging session (TTY allocation, separate cause)

- Diagnosed: orphans had PPID=0 (normal for cross-namespace exec), state `Ssl+ do_epoll_wait`, no host-side `docker compose exec` wrapper alive.
- Confirmed via `docker compose exec --help` that `--no-tty` defaults to `true` in Compose 5.1.3.
- Patched `./workspace` to use `docker exec -it` against the resolved container ID, with a `pkill` cleanup on the `claude` path. `attach` and `exec` got the same treatment for consistency.
- This fix is good and should stay, but did not address the npm probe hang that was the *actual* cause of the current incident. Discovered that on the next attempt.
