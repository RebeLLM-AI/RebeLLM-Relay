// The statistics' daily files: `peers-`, `hot-`, `reports-` and `counts-` plus the UTC day,
// beside the --stats file. Retention deletes whole files; ticks only append.
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

export const DAY_MS = 86_400_000
export type Kind = 'peers' | 'hot' | 'reports' | 'counts'
const NAME = /^(peers|hot|reports|counts)-(\d{4}-\d{2}-\d{2})\.csv$/

/** The UTC day of a time, `YYYY-MM-DD`. @param {number} t */
export const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10)

/** The daily file of `kind` in `dir` for the day of `t`. @param {string} dir @param {Kind} kind @param {number} t */
export const dailyFile = (dir: string, kind: Kind, t: number) => join(dir, `${kind}-${dayOf(t)}.csv`)

/**
 * The daily files in `dir`, oldest day first; any other name, or a date that does not exist,
 * is left out. A missing directory has none.
 */
export async function dailyFiles(dir: string): Promise<{ kind: Kind; start: number; path: string }[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const files: { kind: Kind; start: number; path: string }[] = []
  for (const name of names) {
    const m = NAME.exec(name)
    if (!m) continue
    const start = Date.parse(`${m[2]}T00:00:00.000Z`)
    // Date.parse rolls 02-31 over to March; only a day that round-trips is one of ours.
    if (!Number.isFinite(start) || dayOf(start) !== m[2]) continue
    files.push({ kind: m[1] as Kind, start, path: join(dir, name) })
  }
  return files.sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind))
}
