// The network's expert memory (VRAM plus RAM tiers) over time, for the Network card's chart: 6-hour buckets of the
// `total` rows the statistics write, every bucket ever seen, served as JSON. Aggregates only:
// no peer id leaves the relay through it.
import { createReadStream } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { DAY_MS, dailyFiles } from './daily.ts'

export const BUCKET_MS = 6 * 3600_000
/** Five-minute ticks in a bucket: the most values an open bucket keeps for its medians. */
export const MAX_VALUES = 72
/** Longest `?days=`: a century, so the cut-off stays a valid time. */
const MAX_DAYS = 36_500

// Columns of a `total` row in PEERS_HEADER (stats.ts), the same in files with the old peer column:
// the summed budget, under calls_per_sec the peer count, and the summed RAM tiers (empty in rows
// written before them).
const BUDGET_COL = 7
const PEERS_COL = 10
const RAM_COL = 12

/** Lower median of a non-empty list. @param {number[]} xs */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  return s[(s.length - 1) >> 1]
}

/** A closed bucket's summary. */
export type Point = { t: number; median: number; min: number; max: number; peers: number }
/** An open bucket, still holding its tick values. */
type Open = { key: number; n: number; min: number; max: number; values: number[]; peers: number[] }

/** @param {Open} b @returns {Point & { n: number }} */
const summary = (b: Open): Point & { n: number } => ({
  t: b.key * BUCKET_MS,
  n: b.n,
  median: median(b.values),
  min: b.min,
  max: b.max,
  peers: median(b.peers),
})

/**
 * The buckets: closed ones as summaries only, so memory stays flat (a year is 1 460 of them),
 * and the open one with its tick values for the medians.
 */
export class Buckets {
  closed: (Point & { n: number })[] = []
  open: Open | undefined
  /** The latest row time added; rows at or before it are already counted. */
  upTo = -Infinity

  /**
   * One tick's expert memory; false for a non-number or a time before the open bucket, which a
   * closed summary could not take in.
   */
  add(t: number, budgetBytes: number, peers: number): boolean {
    if (![t, budgetBytes, peers].every(Number.isFinite)) return false
    const key = Math.floor(t / BUCKET_MS)
    if (this.open && key < this.open.key) return false
    if (this.open && key > this.open.key) {
      this.closed.push(summary(this.open))
      this.open = undefined
    }
    const b = (this.open ??= { key, n: 0, min: Infinity, max: -Infinity, values: [], peers: [] })
    b.n++
    b.min = Math.min(b.min, budgetBytes)
    b.max = Math.max(b.max, budgetBytes)
    // More ticks than fit come only from restarts within the bucket; min and max still see them.
    if (b.values.length < MAX_VALUES) {
      b.values.push(budgetBytes)
      b.peers.push(peers)
    }
    this.upTo = Math.max(this.upTo, t)
    return true
  }

  /** Everything held, for history.json: the closed summaries, the open bucket's ticks and `upTo`. */
  save() {
    return { v: 1, upTo: Number.isFinite(this.upTo) ? this.upTo : null, closed: this.closed, open: this.open ?? null }
  }

  /** The buckets of a saved history; throws for anything else. */
  static restore(o: unknown): Buckets {
    const h = o as { v?: unknown; upTo?: unknown; closed?: unknown; open?: unknown }
    const nums = (x, keys) => x && typeof x === 'object' && keys.every((k) => Number.isFinite(x[k]))
    const point = (p) => nums(p, ['t', 'n', 'median', 'min', 'max', 'peers'])
    const open = (b) =>
      nums(b, ['key', 'n', 'min', 'max']) &&
      Array.isArray(b.values) &&
      Array.isArray(b.peers) &&
      b.values.length === b.peers.length
    if (!h || typeof h !== 'object' || h.v !== 1 || !Array.isArray(h.closed) || !h.closed.every(point))
      throw new Error('not a history file')
    if (h.open !== null && !open(h.open)) throw new Error('not a history file')
    if (h.upTo !== null && !Number.isFinite(h.upTo)) throw new Error('not a history file')
    const b = new Buckets()
    b.closed = h.closed.map((p) => ({ ...p }))
    const ob = h.open as Open | undefined
    b.open = ob ? { ...ob, values: [...ob.values], peers: [...ob.peers] } : undefined
    b.upTo = (h.upTo as number) ?? -Infinity
    return b
  }

  /**
   * `{ intervalHours, points }` oldest first; with `days`, only buckets that end within the
   * last `days` days.
   * @param {number} [days] @param {number} [now]
   */
  toJson(days?: number, now: number = Date.now()) {
    const from = days ? now - days * DAY_MS : -Infinity
    const all = this.open ? [...this.closed, summary(this.open)] : this.closed
    return {
      intervalHours: BUCKET_MS / 3600_000,
      points: all
        .filter((p) => p.t + BUCKET_MS > from)
        .map(({ t, median, min, max, peers }) => ({ t, median, min, max, peers })),
    }
  }
}

/**
 * Adds a peers file line to `buckets` when it is a `total` row after `since`.
 * @param {Buckets} buckets @param {string} line @param {number} [since]
 */
function addRow(buckets: Buckets, line: string, since = -Infinity) {
  // Peer ids are quoted, so only a total row has a bare `total` in the second column.
  if (!line.includes(',total,')) return
  const cells = line.split(',')
  if (cells[1] !== 'total') return
  const t = Date.parse(cells[0])
  if (t <= since) return
  const memory = Number(cells[BUDGET_COL]) + (Number(cells[RAM_COL]) || 0)
  buckets.add(t, memory, Number(cells[PEERS_COL]))
}

/** The buckets of a peers file's text. @param {string} text */
export function fromCsv(text: string, buckets: Buckets = new Buckets()) {
  for (const line of text.split('\n')) addRow(buckets, line.trimEnd())
  return buckets
}

/**
 * The buckets of a peers file, read line by line (a day of peer rows can be large); empty
 * when there is no file yet. Rows at or before `since` are skipped.
 * @param {string} file @param {Buckets} [buckets] @param {number} [since]
 */
export async function loadCsv(file: string, buckets: Buckets = new Buckets(), since = -Infinity) {
  const input = createReadStream(file)
  const opened = await new Promise<boolean>((resolve, reject) => {
    input.once('open', () => resolve(true))
    input.once('error', (e) => ((e as NodeJS.ErrnoException).code === 'ENOENT' ? resolve(false) : reject(e)))
  })
  if (!opened) return buckets
  for await (const line of createInterface({ input, crlfDelay: Infinity })) addRow(buckets, line, since)
  return buckets
}

/** Writes the buckets to history.json, whole or not at all. @param {string} file @param {Buckets} buckets */
export async function writeHistory(file: string, buckets: Buckets) {
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(buckets.save()))
  await rename(tmp, file)
}

/**
 * The history at start: history.json (the totals of every bucket ever seen, which the pruned
 * CSVs no longer hold), then the rows newer than it in `csvFile` (the peers file from before
 * the daily files, whose rows are all older) and in the daily peers files beside it, oldest day
 * first; a day that ended before the saved history is not opened. Without history.json, the
 * CSVs alone; an unreadable one is reported through `warn` and treated as missing.
 * @param {string} jsonFile @param {string} csvFile @param {{ warn?: (message: string) => void }} [o]
 */
export async function loadHistory(
  jsonFile: string,
  csvFile: string,
  { warn = () => {} }: { warn?: (message: string) => void } = {},
) {
  let buckets = new Buckets()
  try {
    buckets = Buckets.restore(JSON.parse(await readFile(jsonFile, 'utf8')))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
      warn(`${jsonFile} not read (${(e as Error).message}); the history starts from the CSV`)
  }
  const since = buckets.upTo
  await loadCsv(csvFile, buckets, since)
  for (const f of await dailyFiles(dirname(csvFile)))
    if (f.kind === 'peers' && f.start + DAY_MS > since) await loadCsv(f.path, buckets, since)
  return buckets
}

/**
 * GET /stats/history[?days=N]: the buckets as JSON, cacheable for five minutes. Any other
 * /stats/ path is 404; other paths go to `next` (a connect middleware), else 404 too.
 * `history` may be a getter; without buckets (no statistics) the route goes to `next` too,
 * as on a static host whose page fallback answers, else it is 404.
 * @param {Buckets | (() => Buckets | undefined)} history
 * @param {{ now?: () => number }} [o]
 */
export function createHistoryHandler(
  history: Buckets | (() => Buckets | undefined),
  { now = Date.now }: { now?: () => number } = {},
) {
  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {() => void} [next]
   */
  return (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next?: () => void) => {
    const q = new URL(req.url ?? '/', 'http://stats')
    if (q.pathname !== '/stats/history') {
      if (next && !q.pathname.startsWith('/stats/')) return next()
      return send(res, 404, { error: 'not found' })
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'GET only' })
    const raw = q.searchParams.get('days')
    const days = raw === null ? undefined : Number(raw)
    if (days !== undefined && !(Number.isInteger(days) && days > 0 && days <= MAX_DAYS))
      return send(res, 400, { error: 'days must be a whole number of days' })
    const buckets = typeof history === 'function' ? history() : history
    if (!buckets) return next ? next() : send(res, 404, { error: 'this relay keeps no statistics' })
    send(res, 200, buckets.toJson(days, now()), 'public, max-age=300', req.method === 'HEAD')
  }
}

/**
 * @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body
 * @param {string} [cache] @param {boolean} [head]
 */
function send(
  res: import('node:http').ServerResponse,
  status: number,
  body: unknown,
  cache = 'no-store',
  head = false,
) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
  })
  res.end(head ? undefined : text)
}
