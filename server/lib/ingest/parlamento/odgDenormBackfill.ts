// Backfill for the chamber / legislatura / data / titolo_lower columns on
// parlamento_odg (see the comment on that table in lib/schema.ts).
//
// This lives in lib/ rather than only in scripts/ because it has to run
// automatically at boot, not just when an operator remembers.
//
// The reason is the deploy topology: the CI deploy key on the VPS is pinned to
// a single forced command that resolves to `docker compose pull && up -d`. It
// cannot run arbitrary commands, so a release CANNOT invoke a migration
// script. Without a boot-time hook, the sequence after a release tag would be:
// schema applies the new fields -> 212,939 existing rows still have them empty
// -> /odg/search matches nothing -> the feature is dead in production until a
// human SSHes in by hand. See project-kb/Parlamento read-path performance.md
// and DEPLOY.md.
//
// Idempotent and resumable: rows already carrying the columns are skipped, so
// re-running (every boot, say) is a cheap no-op once the corpus is filled.

import { runQuery } from '../../query.ts'

export interface OdgBackfillResult {
  /** True when there was nothing to do. */
  alreadyComplete: boolean
  seduteUpdated: number
  seduteSkipped: number
  odgRowsWritten: number
  /** Rows still missing a column after the pass; should be 0. */
  remaining: number
  durationMs: number
}

interface SedutaRow {
  id: unknown
  chamber: string
  legislatura: number
  data: unknown
}

/**
 * Cheap-ish guard: is any odg row missing the denormalised columns?
 *
 * Stops at the first hit, so it is fast precisely when there IS work to do.
 * In the steady state (nothing to backfill) it scans, which is why callers
 * should run this off the request path.
 */
export async function odgBackfillNeeded(): Promise<boolean> {
  const rows = await runQuery<Array<{ id: unknown }>>(
    `SELECT id FROM parlamento_odg WHERE titolo_lower IS NONE LIMIT 1;`,
  )
  return (rows?.length ?? 0) > 0
}

/**
 * Fill the denormalised columns.
 *
 * Iterates sedute (~9.8k) rather than odg rows (~213k) and issues one indexed
 * UPDATE per seduta via idx_odg_seduta: three orders of magnitude fewer
 * statements, each seeking instead of scanning.
 *
 * @param force rewrite rows that already carry the columns
 * @param onProgress optional progress sink, called every 500 sedute
 */
export async function backfillOdgDenorm(
  { force = false }: { force?: boolean } = {},
  onProgress?: (done: number, total: number, rowsWritten: number) => void,
): Promise<OdgBackfillResult> {
  const started = Date.now()

  if (!force && !(await odgBackfillNeeded())) {
    return {
      alreadyComplete: true,
      seduteUpdated: 0,
      seduteSkipped: 0,
      odgRowsWritten: 0,
      remaining: 0,
      durationMs: Date.now() - started,
    }
  }

  const sedute = await runQuery<SedutaRow[]>(
    `SELECT id, chamber, legislatura, data FROM parlamento_sedute ORDER BY id ASC;`,
  )
  const list = sedute ?? []

  let seduteUpdated = 0
  let seduteSkipped = 0
  let odgRowsWritten = 0

  for (let i = 0; i < list.length; i += 1) {
    const s = list[i]
    if (!force) {
      // If the first odg row of this seduta already carries the columns, the
      // seduta was ingested post-change (or already backfilled).
      const probe = await runQuery<Array<{ titolo_lower: string | null }>>(
        `SELECT titolo_lower FROM parlamento_odg WHERE seduta_id = $sed LIMIT 1;`,
        { sed: s.id },
      )
      // No odg rows at all (empty transcript) is also nothing to do.
      if (!probe?.length || probe[0].titolo_lower != null) {
        seduteSkipped += 1
        continue
      }
    }

    const updated = await runQuery<Array<{ id: unknown }>>(
      // titolo_lower is derived per row, so it is computed in the UPDATE
      // itself rather than bound as a single value like the other three.
      `UPDATE parlamento_odg
         SET chamber = $chamber,
             legislatura = $leg,
             data = $data,
             titolo_lower = string::lowercase(titolo)
       WHERE seduta_id = $sed
       RETURN id;`,
      {
        sed: s.id,
        chamber: s.chamber,
        leg: s.legislatura,
        // The SDK hands back its own DateTime wrapper for a datetime column;
        // normalise to a real Date, which is what insert/update accepts.
        data: new Date(String(s.data)),
      },
    )
    seduteUpdated += 1
    odgRowsWritten += updated?.length ?? 0

    if (onProgress && (i + 1) % 500 === 0) onProgress(i + 1, list.length, odgRowsWritten)
  }

  const remainingRows = await runQuery<Array<{ n: number }>>(
    `SELECT count() AS n FROM parlamento_odg
     WHERE chamber IS NONE OR titolo_lower IS NONE GROUP ALL;`,
  )

  return {
    alreadyComplete: false,
    seduteUpdated,
    seduteSkipped,
    odgRowsWritten,
    remaining: remainingRows?.[0]?.n ?? 0,
    durationMs: Date.now() - started,
  }
}
