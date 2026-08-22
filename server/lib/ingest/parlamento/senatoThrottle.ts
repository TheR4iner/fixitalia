// -----------------------------------------------------------------------------
// Rate control for senato.it (AWS WAF in challenge mode).
//
// The site rate-limits on cumulative request volume, and getting blocked costs
// roughly a day (the IP is put behind a "Pagina non accessibile" wall). A full
// historical run is thousands of requests, so we deliberately trade speed for
// staying under the limit: a jittered minimum spacing between every navigation,
// plus a periodic long cooldown so any sliding-window counter drains.
//
// All knobs are env-overridable so an operator can dial politeness up (after a
// block) or down (when the site is quiet) without a code change. Defaults are
// conservative on purpose -- "slower but steady, don't get blocked again".
// -----------------------------------------------------------------------------

function envNum(key: string, fallback: number): number {
  const v = Number(process.env[key])
  return Number.isFinite(v) && v >= 0 ? v : fallback
}

// Jittered spacing between consecutive senato.it navigations.
const MIN_DELAY_MS = envNum('SENATO_MIN_DELAY_MS', 6000)
const MAX_DELAY_MS = envNum('SENATO_MAX_DELAY_MS', 12000)
// Every N navigations, take a longer breather to let rate windows drain.
const COOLDOWN_EVERY = envNum('SENATO_COOLDOWN_EVERY', 30)
const COOLDOWN_MS = envNum('SENATO_COOLDOWN_MS', 180000)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let lastAt = 0
let count = 0

/**
 * Await before every senato.it navigation. Enforces jittered spacing and a
 * periodic cooldown. Process-global (one counter) so it throttles the whole
 * run, not per-leg.
 */
export async function senatoThrottle(): Promise<void> {
  count += 1
  if (COOLDOWN_EVERY > 0 && count % COOLDOWN_EVERY === 0) {
    console.log(
      `[senato-throttle] cooldown ${Math.round(COOLDOWN_MS / 1000)}s after ${count} requests`,
    )
    await sleep(COOLDOWN_MS)
  }
  const target = MIN_DELAY_MS + Math.random() * Math.max(0, MAX_DELAY_MS - MIN_DELAY_MS)
  const since = Date.now() - lastAt
  if (lastAt > 0 && since < target) await sleep(target - since)
  lastAt = Date.now()
}
