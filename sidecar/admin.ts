// The admin page's API: a live snapshot of the relay and everything its statistics recorded,
// behind the admin login. Node built-ins only.
import { createHash, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DAY_MS, dailyFiles, dayOf } from './daily.ts'
import type { Buckets } from './history.ts'

// PEERS_HEADER and REPORTS_HEADER of stats.ts; admin.test.ts keeps them equal.
export const PEERS_COLUMNS = [
  ...['time', 'row', 'transport', 'model', 'gpu', 'precision', 'vram_bytes', 'budget_bytes', 'loaded', 'served'],
  ...['calls_per_sec', 'app', 'ram_bytes', 'relayed_bytes', 'loop_lag_ms', 'rss_bytes', 'heap_bytes'],
  ...['reservations', 'subscribers', 'opened', 'streams', 'refused', 'tokens', 'calls_per_sec_sum'],
]
const REPORT_SUMS = [
  ...['requests', 'tokens', 'stops_eos', 'stops_length', 'stops_loop', 'stops_abort', 'tool_calls'],
  ...['loaded_from_storage', 'failures_oom', 'failures_wasm', 'failures_unavailable', 'failures_other', 'parks'],
  ...['node_calls', 'node_errors', 'node_checks_passed', 'node_checks_failed', 'node_marked_down'],
]
const REPORT_MEDIANS = [
  ...['prefill_tok_per_sec', 'decode_tok_per_sec', 'misses_per_token', 'lookahead_rate', 'remote_p50_ms'],
  ...['remote_p95_ms', 'wait_ms_per_token', 'context_p50', 'load_ms', 'node_call_p50_ms', 'node_expert_load_p50_ms'],
  ...['net_up_per_token', 'net_down_per_token'],
]
export const REPORTS_COLUMNS = [
  ...['time', 'app', 'gpu', 'precision', 'vram_bytes', 'budget_bytes', 'phone', 'browser', 'os'],
  ...['requests', 'tokens', 'prefill_tok_per_sec', 'decode_tok_per_sec', 'misses_per_token', 'lookahead_rate'],
  ...['remote_p50_ms', 'remote_p95_ms', 'wait_ms_per_token', 'context_p50', 'stops_eos', 'stops_length'],
  ...['stops_loop', 'stops_abort', 'tool_calls', 'load_ms', 'loaded_from_storage', 'failures_oom', 'failures_wasm'],
  ...['failures_unavailable', 'failures_other', 'parks', 'node_calls', 'node_call_p50_ms', 'node_errors'],
  ...['node_checks_passed', 'node_checks_failed', 'node_marked_down', 'node_expert_load_p50_ms'],
  ...['net_up_per_token', 'net_down_per_token'],
]
/** Column positions by name, from a header's cells. */
const indexOf = (columns: string[]) => Object.fromEntries(columns.map((c, i) => [c, i])) as Record<string, number>

/** Longest `?days=`: a century, as for /stats/history. */
export const MAX_DAYS = 36_500
/** Most points a tick series answers with. */
export const MAX_POINTS = 400
export const STEPS_MS = [5, 15, 30, 60, 120, 360, 720, 1440, 10080].map((m) => m * 60_000)
/** Report values kept per field and day for the medians. */
export const SAMPLES_PER_DAY = 2000
const TOP_HOT = 20

// The ticks' columns: the `total` row's, then the `network` row's, which reuses the columns.
const FROM_TOTAL = {
  peers: 'calls_per_sec',
  vramBytes: 'vram_bytes',
  budgetBytes: 'budget_bytes',
  ramBytes: 'ram_bytes',
  loaded: 'loaded',
  served: 'served',
  callsPerSec: 'calls_per_sec_sum',
}
const FROM_NETWORK = {
  connections: 'transport',
  websocket: 'model',
  webrtc: 'gpu',
  medianAgeSec: 'precision',
  replicasMin: 'vram_bytes',
  replicasMedian: 'budget_bytes',
  replicasMax: 'loaded',
  replicasNone: 'served',
  relayedBytes: 'calls_per_sec',
  loopLagMs: 'loop_lag_ms',
  rssBytes: 'rss_bytes',
  heapBytes: 'heap_bytes',
  reservations: 'reservations',
  subscribers: 'subscribers',
  opened: 'opened',
  streams: 'streams',
  refused: 'refused',
  tokens: 'tokens',
}
export const TICK_COLUMNS = ['t', ...Object.keys(FROM_TOTAL), 'memoryBytes', ...Object.keys(FROM_NETWORK)]
const T = Object.fromEntries(TICK_COLUMNS.map((c, i) => [c, i]))
// A step sums the per-tick counts and keeps the peak of the load gauges; the rest is its mean.
const SUMMED = new Set(['relayedBytes', 'opened', 'streams', 'refused', 'tokens'])
const PEAKED = new Set(['loopLagMs', 'rssBytes', 'heapBytes'])

// scrypt at N=2^14, r=8: 16 MB and tens of ms per check.
const SCRYPT = { N: 16384, r: 8, p: 1 }
const KEY = /^scrypt\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/
/** Verified Authorization headers remembered, as sha256. */
const REMEMBERED = 16
/** Checks waiting at once; past it a login is refused unchecked. */
const MAX_WAITING = 16

/**
 * The relay's key for an admin login `user:password` on a domain: `scrypt.<salt>.<hash>`,
 * base64url, the salt derived from the domain and user so a later deploy writes the same key.
 */
export function adminKey(login: string, domain: string) {
  const colon = login.indexOf(':')
  if (colon < 1) throw new Error('the admin login is user:password')
  const salt = createHash('sha256')
    .update(`rebellm-admin\n${domain}\n${login.slice(0, colon)}`)
    .digest()
    .subarray(0, 16)
  const hash = scryptSync(login, salt, 32, SCRYPT)
  return `scrypt.${salt.toString('base64url')}.${hash.toString('base64url')}`
}

/**
 * A check of `Authorization` headers against a key: one scrypt at a time, and a header that
 * passed is remembered, so a page polling every 5 s costs one scrypt. Throws for a malformed key.
 */
export function adminChecker(key: string): (header: string | undefined) => Promise<boolean> {
  const m = KEY.exec(key)
  if (!m) throw new Error('invalid admin key: expected scrypt.<salt>.<hash>')
  const salt = Buffer.from(m[1], 'base64url')
  const want = Buffer.from(m[2], 'base64url')
  const verified = new Set<string>()
  let queue = Promise.resolve(false)
  let waiting = 0
  return async (header) => {
    const basic = /^Basic +([A-Za-z0-9+/=]+) *$/i.exec(header ?? '')
    if (!basic) return false
    const digest = createHash('sha256')
      .update(header ?? '')
      .digest('hex')
    if (verified.has(digest)) return true
    const login = Buffer.from(basic[1], 'base64').toString('utf8')
    if (login.indexOf(':') < 1 || waiting >= MAX_WAITING) return false
    waiting++
    const run = queue.then(
      () =>
        new Promise<boolean>((resolve) =>
          scrypt(login, salt, 32, SCRYPT, (e, hash) => resolve(!e && timingSafeEqual(hash, want))),
        ),
    )
    queue = run
    const ok = await run.finally(() => waiting--)
    if (ok) {
      verified.add(digest)
      if (verified.size > REMEMBERED) verified.delete(verified.values().next().value!)
    }
    return ok
  }
}

/**
 * GET /admin/api/live and /admin/api/history[?days=N], JSON and never cached. `key` checks the
 * admin login; `null` leaves the API open, for the dev servers only. Other paths go to `next`,
 * else 404. `live` and `history` are getters; `live` may be async, and answers nothing while
 * the relay's snapshot is not available.
 */
export function createAdminHandler({
  key,
  live,
  history = () => undefined,
  dir,
  now = Date.now,
}: {
  key: string | null | undefined
  live: () => unknown | Promise<unknown>
  history?: () => Buckets | undefined
  dir?: string
  now?: () => number
}) {
  if (key === undefined) throw new Error('createAdminHandler needs a key, or null for an open dev API')
  const check = key === null ? async () => true : adminChecker(key)
  const reader = dir ? historyReader(dir) : undefined
  return async (req: IncomingMessage, res: ServerResponse, next?: () => void) => {
    const q = new URL(req.url ?? '/', 'http://admin')
    if (!q.pathname.startsWith('/admin/api/')) return next ? next() : send(res, 404, { error: 'not found' })
    const head = req.method === 'HEAD'
    if (req.method !== 'GET' && !head) return send(res, 405, { error: 'GET only' })
    if (!(await check(req.headers.authorization))) {
      res.setHeader('www-authenticate', 'Basic realm="RebeLLM admin", charset="UTF-8"')
      return send(res, 401, { error: 'admin login required' })
    }
    try {
      if (q.pathname === '/admin/api/live') {
        const snapshot = await live()
        if (!snapshot) return send(res, 503, { error: 'the relay is not running' })
        return send(res, 200, snapshot, head)
      }
      if (q.pathname === '/admin/api/history') {
        const raw = q.searchParams.get('days')
        const days = raw === null ? undefined : Number(raw)
        if (days !== undefined && !(Number.isInteger(days) && days > 0 && days <= MAX_DAYS))
          return send(res, 400, { error: `days must be a whole number from 1 to ${MAX_DAYS}` })
        const t = now()
        const body = reader ? await reader.read(days, t, history()) : emptyHistory(days, t, history())
        return send(res, 200, body, head)
      }
      return send(res, 404, { error: 'not found' })
    } catch (e) {
      console.error(`${new Date().toISOString()} admin API: ${(e as Error).message}`)
      return send(res, 500, { error: 'the statistics could not be read' })
    }
  }
}

function send(res: ServerResponse, status: number, body: unknown, head = false) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(head ? undefined : text)
}

/**
 * A CSV line's cells; quoted cells lose their quotes and their doubled `"`, as csvCell in
 * stats.ts writes them.
 */
export function splitCsv(line: string) {
  const out: string[] = []
  let i = 0
  for (;;) {
    if (line[i] === '"') {
      let s = ''
      i++
      for (;;) {
        const q = line.indexOf('"', i)
        if (q < 0) {
          s += line.slice(i)
          i = line.length
          break
        }
        s += line.slice(i, q)
        if (line[q + 1] !== '"') {
          i = q + 1
          break
        }
        s += '"'
        i = q + 2
      }
      out.push(s)
      const c = line.indexOf(',', i)
      if (c < 0) return out
      i = c + 1
    } else {
      const c = line.indexOf(',', i)
      if (c < 0) {
        out.push(line.slice(i))
        return out
      }
      out.push(line.slice(i, c))
      i = c + 1
    }
  }
}

/** A cell as a number; empty, missing or junk is NaN. */
const num = (v: string | undefined) => (v === undefined || v === '' ? NaN : Number(v))

/** Lower median of a non-empty list. */
function median(xs: ArrayLike<number>) {
  const s = Float64Array.from(xs).sort()
  return s[(s.length - 1) >> 1]
}

/** A counts set at one tick: its `all` count and per field the count of each value. */
export type Tally = { time: string; count: number; shares: Map<string, Map<string, number>> }
export type Day = {
  start: number
  ticks: Float64Array[]
  /** The day's distinct nodes and reporting browsers, from its counts file; null without one. */
  nodes: Tally | null
  reports: number
  reporters: Tally | null
  sums: Float64Array
  samples: number[][]
  hot: Map<number, number>
}

/**
 * Calls `onLine` for each line of a file after its header, and `onHeader` with the header's
 * cells; nothing for a missing file.
 */
async function eachLine(file: string, onLine: (line: string) => void, onHeader?: (cells: string[]) => void) {
  const input = createReadStream(file)
  const opened = await new Promise<boolean>((resolve, reject) => {
    input.once('open', () => resolve(true))
    input.once('error', (e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? resolve(false) : reject(e)))
  })
  if (!opened) return
  let first = true
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (first) {
      first = false
      if (line.startsWith('time,')) {
        onHeader?.(line.split(','))
        continue
      }
    }
    if (line) onLine(line)
  }
}

/**
 * The `nodes` and `reporters` sets of a counts file, each at the tick with the highest `all`
 * count, the latest of equal ones: after a restart the day's count began again from zero.
 */
async function readCounts(file: string) {
  const best: Record<string, Tally | null> = { nodes: null, reporters: null }
  const at: Record<string, Tally | null> = { nodes: null, reporters: null }
  const done = (set: string) => {
    const t = at[set]
    if (t && !(t.count < (best[set]?.count ?? -1))) best[set] = t
  }
  await eachLine(file, (line) => {
    const [time, set, field, value, n] = splitCsv(line)
    if (!(set in at)) return
    if (field === 'all') {
      done(set)
      at[set] = { time, count: num(n) || 0, shares: new Map() }
      return
    }
    const t = at[set]
    if (!t || t.time !== time || !field) return
    let m = t.shares.get(field)
    if (!m) t.shares.set(field, (m = new Map()))
    m.set(value || 'unknown', (m.get(value || 'unknown') ?? 0) + (num(n) || 0))
  })
  done('nodes')
  done('reporters')
  return best
}

/**
 * One UTC day's summary from its peers, reports, hot and counts files: the ticks as numbers,
 * the day's distinct nodes and reporters, the reports' sums and sampled values, and the hot
 * demand. Columns are found by the header, so files from before and after the peer column
 * went read alike; rows per peer are skipped.
 */
export async function readDay(
  start: number,
  files: { peers?: string; reports?: string; hot?: string; counts?: string },
  random = Math.random,
): Promise<Day> {
  const ticks = new Map<string, Float64Array>()
  const tickAt = (time: string) => {
    let row = ticks.get(time)
    if (!row) {
      row = new Float64Array(TICK_COLUMNS.length).fill(NaN)
      row[0] = Date.parse(time)
      ticks.set(time, row)
    }
    return row
  }
  let P = indexOf(PEERS_COLUMNS)
  if (files.peers)
    await eachLine(
      files.peers,
      (line) => {
        const c = splitCsv(line)
        if (c[1] === 'total') {
          const row = tickAt(c[0])
          for (const [k, col] of Object.entries(FROM_TOTAL)) row[T[k]] = num(c[P[col]])
          row[T.memoryBytes] = num(c[P.budget_bytes]) + (num(c[P.ram_bytes]) || 0)
        } else if (c[1] === 'network') {
          const row = tickAt(c[0])
          for (const [k, col] of Object.entries(FROM_NETWORK)) row[T[k]] = num(c[P[col]])
        }
      },
      (h) => (P = indexOf(h)),
    )
  const sums = new Float64Array(REPORT_SUMS.length)
  const samples = REPORT_MEDIANS.map((): number[] => [])
  const seen = REPORT_MEDIANS.map(() => 0)
  let R = indexOf(REPORTS_COLUMNS)
  let reports = 0
  if (files.reports)
    await eachLine(
      files.reports,
      (line) => {
        const c = splitCsv(line)
        if (Number.isNaN(Date.parse(c[0]))) return
        reports++
        REPORT_SUMS.forEach((k, i) => (sums[i] += num(c[R[k]]) || 0))
        REPORT_MEDIANS.forEach((k, i) => {
          const v = num(c[R[k]])
          // Zero means the window had nothing to measure.
          if (!(v > 0)) return
          const n = seen[i]++
          if (n < SAMPLES_PER_DAY) samples[i].push(v)
          else {
            const j = Math.floor(random() * (n + 1))
            if (j < SAMPLES_PER_DAY) samples[i][j] = v
          }
        })
      },
      (h) => (R = indexOf(h)),
    )
  const { nodes, reporters } = files.counts ? await readCounts(files.counts) : { nodes: null, reporters: null }
  const hot = new Map<number, number>()
  if (files.hot)
    await eachLine(files.hot, (line) => {
      const [, layer, expert, demand] = line.split(',').map(Number)
      if (![layer, expert, demand].every(Number.isFinite)) return
      const k = layer * 65536 + expert
      hot.set(k, (hot.get(k) ?? 0) + demand)
    })
  const sorted = [...ticks.values()].filter((r) => Number.isFinite(r[0])).sort((a, b) => a[0] - b[0])
  return { start, ticks: sorted, nodes, reports, reporters, sums, samples, hot }
}

/** The step that keeps a span within MAX_POINTS points. */
export function stepFor(spanMs: number) {
  return STEPS_MS.find((s) => Math.ceil(spanMs / s) <= MAX_POINTS) ?? STEPS_MS[STEPS_MS.length - 1]
}

/**
 * Ticks aggregated per step: counts summed, load gauges at their peak, the rest averaged;
 * `null` where a step has no value.
 * `ticks` oldest first.
 */
export function aggregate(ticks: Float64Array[], step: number) {
  const rows: (number | null)[][] = []
  let key = NaN
  let sum = new Float64Array(TICK_COLUMNS.length)
  let max = new Float64Array(TICK_COLUMNS.length)
  let n = new Uint32Array(TICK_COLUMNS.length)
  const flush = () => {
    if (Number.isNaN(key)) return
    rows.push(
      TICK_COLUMNS.map((c, i) => {
        if (i === 0) return key
        if (!n[i]) return null
        if (SUMMED.has(c)) return sum[i]
        if (PEAKED.has(c)) return max[i]
        return Math.round((sum[i] / n[i]) * 100) / 100
      }),
    )
  }
  for (const row of ticks) {
    const k = Math.floor(row[0] / step) * step
    if (k !== key) {
      flush()
      key = k
      sum = new Float64Array(TICK_COLUMNS.length)
      max = new Float64Array(TICK_COLUMNS.length).fill(-Infinity)
      n = new Uint32Array(TICK_COLUMNS.length)
    }
    for (let i = 1; i < row.length; i++) {
      if (Number.isNaN(row[i])) continue
      sum[i] += row[i]
      max[i] = Math.max(max[i], row[i])
      n[i]++
    }
  }
  flush()
  return rows
}

/** Counts per value, most first, then by name. */
/** A field's counts summed over the days' sets, most first: each node or browser once per day. */
function shares(sets: (Tally | null)[], field: string) {
  const m = new Map<string, number>()
  for (const s of sets) for (const [v, n] of s?.shares.get(field) ?? []) m.set(v, (m.get(v) ?? 0) + n)
  return [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([key, count]) => ({ key, count }))
}

function emptyHistory(days: number | undefined, now: number, buckets: Buckets | undefined) {
  return {
    statistics: false,
    now,
    days: days ?? null,
    from: days ? now - days * DAY_MS : null,
    memory: buckets ? buckets.toJson(days, now) : null,
  }
}

/**
 * The history of a statistics directory. Each day's summary is kept, keyed by its files'
 * paths, sizes and mtimes, so a request reads only files that changed since (today's).
 */
export function historyReader(dir: string, { random = Math.random } = {}) {
  const cache = new Map<number, { sig: string; day: Promise<Day> }>()
  return {
    cache,
    async read(days: number | undefined, now: number, buckets?: Buckets) {
      const files = await dailyFiles(dir)
      const sized = await Promise.all(
        files.map(async (f) => {
          const s = await stat(f.path).catch(() => undefined)
          return { ...f, size: s?.size ?? 0, mtime: s?.mtimeMs ?? 0 }
        }),
      )
      const byDay = new Map<number, typeof sized>()
      for (const f of sized) byDay.set(f.start, [...(byDay.get(f.start) ?? []), f])
      for (const start of cache.keys()) if (!byDay.has(start)) cache.delete(start)
      const from = days ? now - days * DAY_MS : -Infinity
      // A day that overlaps the range counts whole for the per-day figures.
      const inRange = [...byDay.keys()].filter((start) => start + DAY_MS > from && start <= now)
      const summaries = await Promise.all(
        inRange.map((start) => {
          const fs = byDay.get(start) ?? []
          const sig = fs.map((f) => `${f.path}:${f.size}:${f.mtime}`).join('|')
          const hit = cache.get(start)
          if (hit && hit.sig === sig) return hit.day
          const paths = Object.fromEntries(fs.map((f) => [f.kind, f.path]))
          const day = readDay(start, paths, random)
          cache.set(start, { sig, day })
          day.catch(() => cache.delete(start))
          return day
        }),
      )
      return summarize(summaries, { days, now, from, buckets, files: sized })
    },
  }
}

/**
 * The history answer from day summaries, oldest first. No peer id leaves: only counts.
 */
export function summarize(
  summaries: Day[],
  {
    days,
    now,
    from,
    buckets,
    files,
  }: {
    days?: number
    now: number
    from: number
    buckets?: Buckets
    files: { kind: string; start: number; size: number }[]
  },
) {
  const ticks = summaries.flatMap((d) => d.ticks.filter((r) => r[0] >= from && r[0] <= now))
  const first = ticks[0]?.[0]
  const span = days ? days * DAY_MS : first === undefined ? DAY_MS : now - first
  const step = stepFor(span)
  const nodes = summaries.map((d) => d.nodes)
  const reporters = summaries.map((d) => d.reporters)
  const total = (sets: (Tally | null)[]) => sets.reduce((s, t) => s + (t?.count ?? 0), 0)
  const sums = Object.fromEntries(REPORT_SUMS.map((k, i) => [camel(k), summaries.reduce((s, d) => s + d.sums[i], 0)]))
  const medians = Object.fromEntries(
    REPORT_MEDIANS.map((k, i) => {
      const all = summaries.flatMap((d) => d.samples[i])
      return [camel(k), all.length ? median(all) : null]
    }),
  )
  const hot = new Map<number, number>()
  for (const d of summaries) for (const [k, v] of d.hot) hot.set(k, (hot.get(k) ?? 0) + v)
  const hotTotal = [...hot.values()].reduce((a, b) => a + b, 0)
  const sumOf = (rows: Float64Array[], col: string) =>
    rows.reduce((s, r) => s + (Number.isNaN(r[T[col]]) ? 0 : r[T[col]]), 0)
  const maxOf = (rows: Float64Array[], col: string) => {
    const xs = rows.map((r) => r[T[col]]).filter((v) => !Number.isNaN(v))
    return xs.length ? Math.max(...xs) : null
  }
  const tokensAt = REPORT_SUMS.indexOf('tokens')
  const bytes = (kind: string) => files.filter((f) => f.kind === kind).reduce((s, f) => s + f.size, 0)
  return {
    statistics: true,
    now,
    days: days ?? null,
    from: Number.isFinite(from) ? from : null,
    daysFrom: summaries[0]?.start ?? null,
    memory: buckets ? buckets.toJson(days, now) : null,
    ticks: { step, columns: TICK_COLUMNS, rows: aggregate(ticks, step) },
    daily: summaries.map((d) => ({
      day: dayOf(d.start),
      ticks: d.ticks.length,
      peers: d.nodes?.count ?? 0,
      peakPeers: maxOf(d.ticks, 'peers'),
      peakConnections: maxOf(d.ticks, 'connections'),
      relayedBytes: sumOf(d.ticks, 'relayedBytes'),
      streams: sumOf(d.ticks, 'streams'),
      refused: sumOf(d.ticks, 'refused'),
      modelTokens: sumOf(d.ticks, 'tokens'),
      reports: d.reports,
      reporters: d.reporters?.count ?? 0,
      tokensGenerated: d.sums[tokensAt],
    })),
    // Summed over the days: a peer counts once per day it was seen.
    peers: {
      count: total(nodes),
      shares: Object.fromEntries(['gpu', 'app', 'precision', 'transport', 'model'].map((f) => [f, shares(nodes, f)])),
    },
    reports: {
      rows: summaries.reduce((s, d) => s + d.reports, 0),
      reporters: total(reporters),
      sums,
      medians,
      shares: Object.fromEntries(
        ['browser', 'os', 'gpu', 'app', 'precision', 'phone'].map((f) => [f, shares(reporters, f)]),
      ),
    },
    hot: {
      total: hotTotal,
      top: [...hot]
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .slice(0, TOP_HOT)
        .map(([k, demand]) => ({ layer: Math.floor(k / 65536), expert: k % 65536, demand, share: demand / hotTotal })),
    },
    files: {
      count: files.length,
      first: files.length ? dayOf(files[0].start) : null,
      last: files.length ? dayOf(files[files.length - 1].start) : null,
      bytes: { peers: bytes('peers'), reports: bytes('reports'), hot: bytes('hot'), counts: bytes('counts') },
    },
  }
}

/** `snake_case` to `camelCase`. */
const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
