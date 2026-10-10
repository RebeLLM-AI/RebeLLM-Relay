// The relay's statistics: the latest accepted announce per connected peer, the usage reports,
// and every five minutes the rows of the day's files. The relay itself is the Rust process;
// what this code reads of it comes through bridge.ts.
import { createReadStream, createWriteStream } from 'node:fs'
import { appendFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { basename, dirname, join } from 'node:path'
import { splitCsv } from './admin.ts'
import { dailyFile, dailyFiles, dayOf } from './daily.ts'
import { Buckets, writeHistory } from './history.ts'

export const ANNOUNCE_TOPIC = 'rebellm/announce/1'

const b64Length = (v) => {
  try {
    return typeof v === 'string' ? atob(v).length : -1
  } catch {
    return -1
  }
}

/** @type {WeakMap<Uint8Array, { parsed: any, verdict: 'accept' | 'reject' }>} */
const decoded = new WeakMap()

/**
 * One announce decoded once: gossipsub hands its topic validator and its `message` listeners
 * the same Uint8Array, so the parse and the verdict are kept per instance until it is dropped.
 * @param {Uint8Array} data
 */
function announceOf(data) {
  let a = decoded.get(data)
  if (a) return a
  let parsed = null
  try {
    parsed = JSON.parse(new TextDecoder().decode(data))
  } catch {
    // Undecodable: null, and rejected below.
  }
  a = { parsed, verdict: verdictOf(parsed) }
  decoded.set(data, a)
  return a
}

/**
 * The parsed JSON of an announce, or null when it does not parse. Shared, so read only.
 * @param {Uint8Array} data
 */
export function decodeAnnounce(data) {
  return announceOf(data).parsed
}

/**
 * Gossip verdict for an announce: 'reject' for anything browsers would not decode (see
 * decodeAnnounce in the web app). The relay validates gossip itself; here the verdict decides
 * what the statistics keep.
 * @param {Uint8Array} data
 * @returns {'accept' | 'reject'}
 */
export function announceVerdict(data) {
  return announceOf(data).verdict
}

/** @returns {'accept' | 'reject'} */
function verdictOf(o) {
  if (!o || o.v !== 1 || typeof o.model !== 'string') return 'reject'
  const { layers, experts } = o
  if (!Number.isInteger(layers) || !Number.isInteger(experts) || layers <= 0 || experts <= 0) return 'reject'
  if (layers * experts > 1 << 20) return 'reject'
  const bits = Math.ceil((layers * experts) / 8)
  if (b64Length(o.served) !== bits) return 'reject'
  if (o.hot && b64Length(o.hot) !== bits) return 'reject'
  if (o.demand && b64Length(o.demand) !== layers * experts * 2) return 'reject'
  return 'accept'
}

export const REPORT_TOPIC = 'rebellm/report/1'
/** Longest usage report a browser sends. */
export const REPORT_MAX_BYTES = 2048

/** The transport a multiaddr names: circuit, wss, ws, else other. @param {unknown} addr */
export function transportOf(addr) {
  const a = String(addr ?? '')
  if (a.includes('/p2p-circuit')) return 'circuit'
  if (/\/(wss|tls\/ws|tls\/sni\/[^/]+\/ws)(\/|$)/.test(a)) return 'wss'
  if (/\/ws(\/|$)/.test(a)) return 'ws'
  return a ? 'other' : '-'
}

/** Set bits of a base64 bitset: the experts an announce serves. @param {string} b64 */
function popcount(b64) {
  let n = 0
  for (const c of atob(b64)) for (let b = c.charCodeAt(0); b; b &= b - 1) n++
  return n
}

const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined)

/** The CSV fields of a parsed announce; `vramBytes`, `app` and `ramBytes` stay undefined when it has none. */
function fieldsOf(o) {
  return {
    model: o.model.slice(0, 64),
    gpu: text(o.gpu, 32),
    precision: text(o.precision, 8),
    vramBytes: o.vramBytes === undefined ? undefined : count(o.vramBytes),
    budgetBytes: count(o.budgetBytes),
    loaded: count(o.loaded),
    served: popcount(o.served),
    callsPerSec: Math.round(count(o.callsPerSec) * 100) / 100,
    app: text(o.app, 64),
    ramBytes: o.ramBytes === undefined ? undefined : count(o.ramBytes),
  }
}

/**
 * The CSV fields of an announce the gossip validator accepts, or null for any other.
 * @param {Uint8Array} data
 */
export function announceFields(data) {
  const { parsed, verdict } = announceOf(data)
  return verdict === 'accept' ? fieldsOf(parsed) : null
}

/** Shape, served bits and demand of an accepted announce, for replicas and hot experts. */
function bitsOf(o) {
  const n = o.layers * o.experts
  const raw = o.demand ? Buffer.from(o.demand, 'base64') : undefined
  // Browsers send the Uint16Array's bytes, little-endian on every platform they run on.
  const demand = raw && Uint16Array.from({ length: n }, (_, i) => raw.readUInt16LE(2 * i))
  return { layers: o.layers, experts: o.experts, served: Buffer.from(o.served, 'base64'), demand }
}

export const STATS_INTERVAL_MS = 5 * 60_000
/** How long a statistics or report row stays: the privacy notice's retention. */
export const RETENTION_MS = 365 * 86_400_000
export const PRUNE_INTERVAL_MS = 86_400_000
export const HISTORY_FILE = 'history.json'
export const HOT_EXPERTS = 256
// Newer columns come last, so files written before them keep their columns. The second column
// held peer ids until the files lost them; it names the row now.
export const PEERS_HEADER =
  'time,row,transport,model,gpu,precision,vram_bytes,budget_bytes,loaded,served,calls_per_sec,app,ram_bytes,relayed_bytes,loop_lag_ms,rss_bytes,heap_bytes,reservations,subscribers,opened,streams,refused,tokens,calls_per_sec_sum'
/** The columns only the network row fills, after `loop_lag_ms`. */
const NETWORK_ONLY = 8
export const COUNTS_HEADER = 'time,set,field,value,count'
/** Peer ids held per day set; later ones that day are not counted, so a flood of keys costs no memory. */
export const MAX_DAY_IDS = 100_000
const NODE_FIELDS = ['gpu', 'precision', 'app', 'transport', 'model', 'budget']
const REPORTER_FIELDS = ['app', 'gpu', 'precision', 'phone', 'browser', 'os']
type Tally = Record<string, string | undefined>
const GIB = 2 ** 30

/** An expert budget's power-of-two bucket in GiB: `<1GiB`, `1-2GiB` ... `32GiB+`. */
export function budgetBucket(bytes: number) {
  if (!(bytes >= GIB)) return '<1GiB'
  if (bytes >= 32 * GIB) return '32GiB+'
  const lo = 2 ** Math.floor(Math.log2(bytes / GIB))
  return `${lo}-${lo * 2}GiB`
}

/** The counted fields of a node: its announce's, the transport and the budget bucket. */
const nodeTally = (transport: string, f: ReturnType<typeof fieldsOf>): Tally => ({
  gpu: f.gpu,
  precision: f.precision,
  app: f.app,
  transport,
  model: f.model,
  budget: budgetBucket(f.budgetBytes),
})

/** The counted fields of a reporting browser, from reportFields' cells. */
const reporterTally = (c: unknown[]): Tally => ({
  app: c[0] as string | undefined,
  gpu: c[1] as string | undefined,
  precision: c[2] as string | undefined,
  // A number from reportFields, a cell's text in a migrated row.
  phone: Number(c[5]) ? 'phone' : 'desktop',
  browser: c[6] as string,
  os: c[7] as string,
})

/**
 * The counts file's rows of one set: `all` with the count, then per field each value and its
 * count, most first; an empty value is unknown.
 */
export function countRows(time: string, set: string, fields: string[], items: Iterable<Tally>) {
  const list = [...items]
  const rows = [`${time},${set},all,,${list.length}`]
  for (const field of fields) {
    const m = new Map<string, number>()
    for (const it of list) m.set(it[field] ?? '', (m.get(it[field] ?? '') ?? 0) + 1)
    for (const [v, n] of [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)))
      rows.push(`${time},${set},${field},${v ? csvCell(v) : ''},${n}`)
  }
  return rows
}

/** Sets a day set's entry, unless the set is full and the id new. */
function remember(m: Map<string, Tally>, id: string, v: Tally) {
  if (m.has(id) || m.size < MAX_DAY_IDS) m.set(id, v)
}

/** The relay's counts since start, kept in memory only. */
export function newCounters() {
  return {
    connectionsOpened: 0,
    connectionsClosed: 0,
    refused: 0,
    reservationsGranted: 0,
    reservationsRefused: 0,
    relayedStreams: 0,
    relayedBytes: 0,
    announcesAccepted: 0,
    announcesRejected: 0,
    reportsAccepted: 0,
    reportsRejected: 0,
    tokens: 0,
  }
}
export type Counters = ReturnType<typeof newCounters>
export type Probe = { rssBytes?: number; heapBytes?: number; reservations?: number; subscribers?: number }
/** Sampling interval of the event-loop delay histogram, in ms. */
export const LOOP_RESOLUTION_MS = 20
export const HOT_HEADER = 'time,layer,expert,demand'

// A report's numbers in the order of the web app's Report interface.
const REPORT_TRUNK = [
  'requests',
  'tokens',
  'prefillTokPerSec',
  'decodeTokPerSec',
  'missesPerToken',
  'lookaheadRate',
  'remoteP50Ms',
  'remoteP95Ms',
  'waitMsPerToken',
  'contextP50',
  'stops.eos',
  'stops.length',
  'stops.loop',
  'stops.abort',
  'toolCalls',
  'loadMs',
  'loadedFromStorage',
  'failures.oom',
  'failures.wasm',
  'failures.unavailable',
  'failures.other',
  'parks',
]
const REPORT_NODE = ['calls', 'callP50Ms', 'errors', 'checksPassed', 'checksFailed', 'markedDown', 'expertLoadP50Ms']
// Trunk numbers added later go last, so a day file begun before them keeps its columns in place.
const REPORT_TRUNK_LATE = ['netUpPerToken', 'netDownPerToken']
const snake = (path) => path.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replaceAll('.', '_')
export const REPORTS_HEADER = [
  'time,app,gpu,precision,vram_bytes,budget_bytes,phone,browser,os',
  ...REPORT_TRUNK.map(snake),
  ...REPORT_NODE.map((k) => `node_${snake(k)}`),
  ...REPORT_TRUNK_LATE.map(snake),
].join(',')
const BROWSERS = ['chrome', 'brave', 'firefox', 'safari', 'other']
const OSES = ['windows', 'mac', 'linux', 'android', 'ios', 'other']
/** Reports kept between two ticks; a flood beyond it is dropped, not buffered. */
export const MAX_REPORTS = 10_000

const at = (o, path) => path.split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), o)
// Booleans as 1 and 0, so a spreadsheet sums them.
const cell = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : count(v))
const family = (v, all) => (all.includes(v) ? v : 'other')

/**
 * The CSV cells of a usage report the gossip validator would accept, from `app` on, or null.
 * Unknown fields are ignored and missing numbers are 0, so newer browsers still write rows.
 * @param {Uint8Array} data
 */
export function reportFields(data) {
  if (data.length > REPORT_MAX_BYTES) return null
  let o
  try {
    o = JSON.parse(new TextDecoder().decode(data))
  } catch {
    return null
  }
  if (!o || typeof o !== 'object' || o.v !== 1) return null
  const m = o.machine && typeof o.machine === 'object' ? o.machine : {}
  return [
    text(o.app, 64),
    text(m.gpu, 32),
    m.precision === 'f16' || m.precision === 'f32' ? m.precision : undefined,
    count(m.vramBytes),
    count(m.budgetBytes),
    cell(m.phone === true),
    family(m.browser, BROWSERS),
    family(m.os, OSES),
    ...REPORT_TRUNK.map((k) => cell(at(o.trunk, k))),
    ...REPORT_NODE.map((k) => cell(at(o.node, k))),
    ...REPORT_TRUNK_LATE.map((k) => cell(at(o.trunk, k))),
  ]
}

/**
 * A CSV cell: numbers plain, nothing for undefined, strings quoted with `"` doubled. Control
 * characters go, so a row stays one line for grep and tail, and a leading formula character
 * gets a `'`, so a spreadsheet does not run a peer's string.
 */
export function csvCell(v) {
  if (v === undefined || v === null) return ''
  if (typeof v === 'number') return String(v)
  const s = String(v).replace(/\p{Cc}/gu, ' ')
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replaceAll('"', '""')}"`
}

/** Lower median of a non-empty list. @param {number[]} xs */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  return s[(s.length - 1) >> 1]
}

/**
 * Replicas per expert and summed demand over the model most peers announce; peers of another
 * model or shape do not count, their expert indices mean other experts.
 */
function expertTotals(entries) {
  const peersOf = new Map()
  for (const e of entries) peersOf.set(e.fields.model, (peersOf.get(e.fields.model) ?? 0) + 1)
  const model = [...peersOf].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0]
  const first = entries.find((e) => e.fields.model === model)
  if (!first) return undefined
  const { layers, experts } = first.bits
  const n = layers * experts
  const replicas = new Uint32Array(n)
  const demand = new Float64Array(n)
  for (const { fields, bits } of entries) {
    if (fields.model !== model || bits.layers !== layers || bits.experts !== experts) continue
    for (let i = 0; i < n; i++) if (bits.served[i >> 3] & (1 << (i & 7))) replicas[i]++
    if (bits.demand) for (let i = 0; i < n; i++) demand[i] += bits.demand[i]
  }
  return { experts, replicas, demand }
}

/**
 * The relay's statistics: the latest accepted announce per connected peer, and per tick the
 * lines for the day's peers file (a `total` and a `network` row), hot file (the hottest experts
 * by summed demand), reports file (a row per usage report received since the last tick) and
 * counts file (the nodes in the window and the day's distinct nodes and reporters by field),
 * all beside `file` (daily.ts). Peer ids stay in memory: no line carries one.
 */
export class RelayStats {
  /** @type {Map<string, { at: number, transport: string, fields: ReturnType<typeof fieldsOf>, bits: ReturnType<typeof bitsOf> }>} */
  peers = new Map()
  /** Bytes relayed through the circuit relay since the last tick. */
  relayed = 0
  /** The same bytes per peer, counted for both ends of a stream. @type {Map<string, number>} */
  relayedBy = new Map()
  /** The running tick's write. */
  pending = Promise.resolve()
  /** The running prune; apart from the ticks, which write only the day's files. */
  pruning = Promise.resolve()
  /** The cells of the usage reports received since the last tick, without time or peer. */
  reports: string[] = []
  /** The reporters since the last tick, by peer id. */
  reporting = new Map<string, Tally>()
  /** The UTC day's distinct nodes and reporters, by peer id: memory only, new each day. */
  day = { key: '', nodes: new Map<string, Tally>(), reporters: new Map<string, Tally>() }

  /** @type {string} */
  file = ''
  /** @type {string} */
  dir = ''
  /** @type {{ peers: string, hot: string, reports: string }} */
  legacy = { peers: '', hot: '', reports: '' }
  /** @type {string} */
  historyFile = ''
  /** @type {number} */
  windowMs = 0
  /** @type {() => number} */
  now = () => Date.now()
  /** @type {Buckets | undefined} */
  history: Buckets | undefined
  /** @type {percentile(p: number): number, reset(): void} | undefined */
  loopDelay: { percentile(p: number): number; reset(): void } | undefined
  counters: Counters | undefined
  probe: (() => Probe) | undefined
  /** The counters at the last tick, for the network row's per-tick counts. */
  #base: Partial<Counters> = {}

  /**
   * `loopDelay` is the event-loop delay histogram the network row reads and each tick resets.
   * `counters` are the relay's (newCounters) and `probe` reads its gauges; the network row's
   * last columns stay empty without them.
   * `file` is the base path: the daily files go beside it, and it names the peers file from
   * before them, which with `hot.csv` and `reports.csv` beside it is only pruned now.
   */
  constructor({
    file,
    historyFile = join(dirname(file), HISTORY_FILE),
    windowMs = STATS_INTERVAL_MS,
    now = () => Date.now(),
    history = undefined,
    loopDelay = undefined,
    counters = undefined,
    probe = undefined,
  }: {
    file: string
    historyFile?: string
    windowMs?: number
    now?: () => number
    history?: Buckets
    loopDelay?: { percentile(p: number): number; reset(): void }
    counters?: Counters
    probe?: () => Probe
  }) {
    this.counters = counters
    this.probe = probe
    this.#base = { ...counters }
    this.file = file
    this.dir = dirname(file)
    this.legacy = { peers: file, hot: join(this.dir, 'hot.csv'), reports: join(this.dir, 'reports.csv') }
    this.historyFile = historyFile
    this.windowMs = windowMs
    this.now = now
    /** The expert memory history each tick's total goes into. */
    this.history = history
    this.loopDelay = loopDelay
  }

  /** The p99 event-loop lag since the last reset in whole ms, or undefined without a histogram. */
  loopLagMs() {
    if (!this.loopDelay) return undefined
    // Node counts the whole sampling interval, so an idle loop reads the resolution: subtract it.
    return Math.max(0, Math.round(this.loopDelay.percentile(99) / 1e6) - LOOP_RESOLUTION_MS)
  }

  /** Keeps a usage report's cells for the next tick and its peer for the day's reporters; false for one that does not decode. */
  recordReport(peer, data) {
    const fields = reportFields(data)
    if (!fields || this.reports.length >= MAX_REPORTS) return false
    this.reports.push(fields.map(csvCell).join(','))
    this.reporting.set(peer, reporterTally(fields))
    return true
  }

  /** Keeps an accepted announce as the peer's latest; false for one the validator rejects. */
  record(peer, transport, data) {
    const { parsed, verdict } = announceOf(data)
    if (verdict !== 'accept') return false
    this.peers.set(peer, { at: this.now(), transport, fields: fieldsOf(parsed), bits: bitsOf(parsed) })
    return true
  }

  forget(peer) {
    this.peers.delete(peer)
  }

  /** Counts relayed bytes once for the network and once per peer at either end. @param {string[]} peers */
  recordRelayed(peers, bytes) {
    this.relayed += bytes
    for (const p of peers) this.relayedBy.set(p, (this.relayedBy.get(p) ?? 0) + bytes)
  }

  /**
   * The tick's lines; `connections` are the relay's open ones. Adds the window's nodes and the
   * reporters since the last tick to the day's sets, starting new ones on a new UTC day.
   * @param {{ remoteAddr: unknown, timeline?: { open?: number } }[]} connections
   */
  lines(connections) {
    const now = this.now()
    const time = new Date(now).toISOString()
    const live = this.#within(now)
    if (this.day.key !== dayOf(now)) this.day = { key: dayOf(now), nodes: new Map(), reporters: new Map() }
    const tallies = live.map(([id, e]) => [id, nodeTally(e.transport, e.fields)] as const)
    for (const [id, t] of tallies) remember(this.day.nodes, id, t)
    for (const [id, t] of this.reporting) remember(this.day.reporters, id, t)
    const counts = [
      ...countRows(
        time,
        'live',
        NODE_FIELDS,
        tallies.map(([, t]) => t),
      ),
      ...countRows(time, 'nodes', NODE_FIELDS, this.day.nodes.values()),
      ...countRows(time, 'reporters', REPORTER_FIELDS, this.day.reporters.values()),
    ]
    const relayedOf = (id) => this.relayedBy.get(id) ?? 0
    const empty = Array(NETWORK_ONLY).fill('')
    const sum = (k) => live.reduce((s, [, e]) => s + (e.fields[k] ?? 0), 0)
    const sums = [sum('vramBytes'), sum('budgetBytes'), sum('loaded'), sum('served')]
    const relayedSum = live.reduce((s, [id]) => s + relayedOf(id), 0)
    const calls = Math.round(sum('callsPerSec') * 100) / 100
    const total = [
      time,
      'total',
      '',
      '',
      '',
      '',
      ...sums,
      live.length,
      '',
      sum('ramBytes'),
      relayedSum,
      '',
      ...empty,
      calls,
    ]
    const p = this.probe?.() ?? {}
    const grown = (k) => (this.counters ? this.counters[k] - (this.#base[k] ?? 0) : undefined)
    const ex = expertTotals(live.map(([, e]) => e))
    const replicas = ex ? ex.replicas.slice().sort() : []
    const n = replicas.length
    const transports = connections.map((c) => transportOf(c.remoteAddr))
    const ages = connections.map((c) => (now - (c.timeline?.open ?? now)) / 1000)
    const network = [
      time,
      'network',
      connections.length,
      transports.filter((t) => t === 'ws' || t === 'wss').length,
      connections.filter((c) => String(c.remoteAddr).includes('/webrtc')).length,
      ages.length ? Math.round(median(ages)) : '',
      ...(n
        ? [replicas[0], replicas[(n - 1) >> 1], replicas[n - 1], replicas.filter((r) => r === 0).length]
        : ['', '', '', '']),
      this.relayed,
      '',
      '',
      '',
      this.loopLagMs() ?? '',
      ...[p.rssBytes, p.heapBytes, p.reservations, p.subscribers].map((v) => (Number.isFinite(v) ? v : '')),
      ...['connectionsOpened', 'relayedStreams', 'refused', 'tokens'].map((k) => grown(k) ?? ''),
      '',
    ]
    const hot = ex
      ? [...ex.demand.keys()]
          .filter((i) => ex.demand[i] > 0)
          .sort((a, b) => ex.demand[b] - ex.demand[a] || a - b)
          .slice(0, HOT_EXPERTS)
          .map((i) => `${time},${Math.floor(i / ex.experts)},${i % ex.experts},${ex.demand[i]}`)
      : []
    const memoryBytes = sums[1] + sum('ramBytes')
    return { peers: [total.join(','), network.join(',')], hot, counts, memoryBytes, count: live.length }
  }

  /** The peers seen within the window. @param {number} now */
  #within(now) {
    return [...this.peers].filter(([, e]) => now - e.at <= this.windowMs)
  }

  /** The announcing peers right now: their sums, replicas and one row each, for the admin page. */
  live() {
    const now = this.now()
    const live = this.#within(now)
    const sum = (k) => live.reduce((s, [, e]) => s + (e.fields[k] ?? 0), 0)
    const ex = expertTotals(live.map(([, e]) => e))
    const r = ex ? ex.replicas.slice().sort() : []
    return {
      count: live.length,
      vramBytes: sum('vramBytes'),
      budgetBytes: sum('budgetBytes'),
      ramBytes: sum('ramBytes'),
      loaded: sum('loaded'),
      served: sum('served'),
      callsPerSec: Math.round(sum('callsPerSec') * 100) / 100,
      replicas: r.length
        ? { min: r[0], median: r[(r.length - 1) >> 1], max: r[r.length - 1], none: r.filter((x) => x === 0).length }
        : null,
      relayedBytes: this.relayed,
      rows: live.map(([peer, e]) => ({
        peer,
        transport: e.transport,
        ...e.fields,
        relayedBytes: this.relayedBy.get(peer) ?? 0,
        ageSec: Math.round((now - e.at) / 1000),
      })),
    }
  }

  /** Appends the tick's lines to the day's files, each with its header when this creates it, feeds the history and saves it. */
  async tick(connections) {
    const now = this.now()
    const { peers, hot, counts, memoryBytes, count } = this.lines(connections)
    this.history?.add(now, memoryBytes, count)
    // The tick's time, not the arrival: rows of one tick do not order against gossip timing.
    const time = new Date(now).toISOString()
    const reports = this.reports.splice(0).map((r) => `${time},${r}`)
    this.reporting.clear()
    this.loopDelay?.reset()
    this.relayed = 0
    this.relayedBy.clear()
    this.#base = { ...this.counters }
    await appendCsv(dailyFile(this.dir, 'peers', now), PEERS_HEADER, peers)
    await appendCsv(dailyFile(this.dir, 'hot', now), HOT_HEADER, hot)
    await appendCsv(dailyFile(this.dir, 'reports', now), REPORTS_HEADER, reports)
    await appendCsv(dailyFile(this.dir, 'counts', now), COUNTS_HEADER, counts)
    if (this.history) await writeHistory(this.historyFile, this.history)
  }

  /** Rewrites the statistics files that still hold peer ids (migrateStats). */
  migrate(now = this.now()) {
    return migrateStats(this.dir, { peers: this.legacy.peers, reports: this.legacy.reports }, now - RETENTION_MS)
  }

  /**
   * Deletes the daily files whose day began more than the retention ago, reading no row, and
   * drops the old rows from the files from before them, deleting each once it holds none. The
   * totals live on in history.json. Returns the daily files deleted and the rows dropped.
   */
  async prune(now = this.now()) {
    const cutoff = now - RETENTION_MS
    const deleted: string[] = []
    for (const f of await dailyFiles(this.dir)) {
      if (f.start >= cutoff) break
      await unlinkIfThere(f.path)
      deleted.push(f.path)
    }
    /** @type {Record<string, number>} */
    const dropped = {}
    for (const [kind, file] of Object.entries(this.legacy)) {
      const r = await pruneCsv(file, cutoff)
      dropped[kind] = r?.dropped ?? 0
      // Nothing appends to these any more: once empty they are done.
      if (r && r.kept === 0) await unlinkIfThere(file)
    }
    return { deleted, dropped }
  }
}

/** @param {string} file */
async function unlinkIfThere(file) {
  try {
    await unlink(file)
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ e.code !== 'ENOENT') throw e
  }
}

/** A file's lines, or undefined for a missing file. */
async function linesOf(file: string) {
  const input = createReadStream(file)
  const opened = await new Promise((resolve, reject) => {
    input.once('open', () => resolve(true))
    input.once('error', (e) => ((e as NodeJS.ErrnoException).code === 'ENOENT' ? resolve(false) : reject(e)))
  })
  return opened ? createInterface({ input, crlfDelay: Infinity }) : undefined
}

/**
 * Rewrites a file line by line through a temp file and a rename: `map` gets each line and
 * whether it is the first, and returns the line to write or null to drop it. False for a
 * missing file.
 */
async function rewriteCsv(file: string, map: (line: string, first: boolean) => string | null) {
  const lines = await linesOf(file)
  if (!lines) return false
  const tmp = `${file}.tmp`
  const out = createWriteStream(tmp)
  let first = true
  for await (const line of lines) {
    const kept = map(line, first)
    first = false
    if (kept === null) continue
    if (!out.write(`${kept}\n`)) await new Promise<void>((resolve) => out.once('drain', () => resolve()))
  }
  await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve(undefined))))
  await rename(tmp, file)
  return true
}

/**
 * Rewrites a statistics CSV without the rows whose first cell, an ISO time, is before `cutoff`;
 * the header and rows it cannot read stay. Returns the rows dropped and the rows kept after the
 * header, undefined for a missing file.
 * @param {string} file @param {number} cutoff
 */
export async function pruneCsv(file, cutoff) {
  let dropped = 0
  let kept = 0
  const done = await rewriteCsv(file, (line, header) => {
    const t = header ? NaN : Date.parse(line.slice(0, line.indexOf(',')))
    if (!Number.isNaN(t) && t < cutoff) {
      dropped++
      return null
    }
    if (!header && line) kept++
    return line
  })
  return done ? { dropped, kept } : undefined
}

/** A libp2p peer id as old files wrote it: Ed25519, secp256k1 or RSA, base58. */
const PEER_ID = /^(12D3KooW|16Uiu2HA|Qm)[1-9A-HJ-NP-Za-km-z]{30,}$/
const ROW_NAMES = new Set(['total', 'network'])
// Positions in every peers header written so far, with or without the peer id.
const PEER_COLS = { transport: 2, model: 3, gpu: 4, precision: 5, budget: 7, app: 11 }

/** A header with its second column renamed, or dropped for null; the current one when it extends it. */
function migratedHeader(header: string, second: string | null, current: string) {
  const c = header.split(',')
  const own = [c[0], ...(second === null ? [] : [second]), ...c.slice(2)].join(',')
  return current.startsWith(own) ? current : own
}

/** A peers file's per-node row: a time and a second cell other than a row name. */
function nodeRow(c: string[]) {
  return !Number.isNaN(Date.parse(c[0])) && c[1] !== undefined && !ROW_NAMES.has(c[1])
}

/** A reports row with a peer id: every row under a header naming it, or one an older relay appended with a cell more. */
function reportWithPeer(c: string[], peerHeader: boolean, columns: number) {
  if (Number.isNaN(Date.parse(c[0]))) return false
  return peerHeader || (PEER_ID.test(c[1] ?? '') && c.length > columns)
}

/**
 * Takes the peer ids out of the statistics files of `dir` and the single `legacy` files from
 * before the daily ones. Per UTC day of the rows that held ids it first writes a counts file
 * with the day's distinct nodes and reporters, unless one exists, then rewrites the files
 * without the per-node rows and the reports' peer column. Daily files of days before `cutoff`
 * are left to the prune. Files without ids are not touched, so a second run does nothing.
 */
export async function migrateStats(dir: string, legacy: { peers?: string; reports?: string }, cutoff: number) {
  const daily = (await dailyFiles(dir)).filter((f) => f.start >= cutoff)
  const files = [
    ...(legacy.peers ? [{ kind: 'peers', path: legacy.peers }] : []),
    ...(legacy.reports ? [{ kind: 'reports', path: legacy.reports }] : []),
    ...daily.filter((f) => f.kind === 'peers' || f.kind === 'reports'),
  ]
  const days = new Map<string, { time: string; nodes: Map<string, Tally>; reporters: Map<string, Tally> }>()
  const dayAt = (time: string) => {
    const t = Date.parse(time)
    const key = dayOf(t)
    // Its files go at the prune.
    if (Date.parse(key) < cutoff) return undefined
    let d = days.get(key)
    if (!d) days.set(key, (d = { time, nodes: new Map(), reporters: new Map() }))
    if (t > Date.parse(d.time)) d.time = time
    return d
  }
  const work: { kind: string; path: string; peerHeader: boolean; columns: number }[] = []
  for (const f of files) {
    const lines = await linesOf(f.path)
    if (!lines) continue
    let first = true
    let peerHeader = false
    let columns = Infinity
    let dirty = false
    for await (const line of lines) {
      if (first) {
        first = false
        if (line.startsWith('time,')) {
          const h = line.split(',')
          peerHeader = h[1] === 'peer'
          columns = h.length
          dirty ||= peerHeader
          continue
        }
      }
      if (!line) continue
      const c = splitCsv(line)
      if (f.kind === 'peers') {
        if (!nodeRow(c)) continue
        dirty = true
        const node: Tally = Object.fromEntries(Object.entries(PEER_COLS).map(([k, i]) => [k, c[i] || undefined]))
        node.budget = budgetBucket(Number(node.budget))
        const d = dayAt(c[0])
        if (d) remember(d.nodes, c[1], node)
      } else {
        if (!reportWithPeer(c, peerHeader, columns)) continue
        dirty = true
        const d = dayAt(c[0])
        if (d) remember(d.reporters, c[1], reporterTally(c.slice(2).map((v) => v || undefined)))
      }
    }
    if (dirty) work.push({ ...f, peerHeader, columns })
  }
  const counts: { path: string; nodes: number; reporters: number; written: boolean }[] = []
  for (const [key, d] of [...days].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const path = dailyFile(dir, 'counts', Date.parse(key))
    const exists = await stat(path).then(
      () => true,
      () => false,
    )
    counts.push({ path, nodes: d.nodes.size, reporters: d.reporters.size, written: !exists })
    if (exists) continue
    const rows = [
      ...(d.nodes.size ? countRows(d.time, 'nodes', NODE_FIELDS, d.nodes.values()) : []),
      ...(d.reporters.size ? countRows(d.time, 'reporters', REPORTER_FIELDS, d.reporters.values()) : []),
    ]
    await writeFile(`${path}.tmp`, [COUNTS_HEADER, ...rows].map((l) => `${l}\n`).join(''))
    await rename(`${path}.tmp`, path)
  }
  const rewritten: { path: string; kind: string; rows: number }[] = []
  for (const f of work) {
    let rows = 0
    await rewriteCsv(f.path, (line, first) => {
      if (first && line.startsWith('time,')) {
        if (f.kind === 'peers') return migratedHeader(line, 'row', PEERS_HEADER)
        return f.peerHeader ? migratedHeader(line, null, REPORTS_HEADER) : line
      }
      if (!line) return line
      const c = splitCsv(line)
      if (f.kind === 'peers') {
        if (!nodeRow(c)) return line
        rows++
        return null
      }
      if (!reportWithPeer(c, f.peerHeader, f.columns)) return line
      rows++
      // Peer ids hold no comma or quote, so the cell ends at the next comma.
      const a = line.indexOf(',')
      const b = line.indexOf(',', a + 1)
      return b < 0 ? line.slice(0, a) : line.slice(0, a) + line.slice(b)
    })
    rewritten.push({ path: f.path, kind: f.kind, rows })
  }
  return { files: rewritten, counts }
}

/** The log lines of migrateStats' answer: one per counts file and per rewritten file. */
export function migrationLog({ files, counts }: Awaited<ReturnType<typeof migrateStats>>) {
  return [
    ...counts.map(
      (c) =>
        `stats migrated: ${basename(c.path)} ${c.written ? 'written' : 'kept'} (${c.nodes} nodes, ${c.reporters} reporters)`,
    ),
    ...files.map((f) => `stats migrated: ${basename(f.path)} without peer ids (${f.rows} rows)`),
  ]
}

async function appendCsv(file, header, lines) {
  try {
    await writeFile(file, `${header}\n`, { flag: 'wx' })
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
  }
  if (lines.length) await appendFile(file, lines.map((l) => `${l}\n`).join(''))
}

// A full disk or a moved file costs the statistics, not the relay.
const defaultStatsError = (e) => console.error(`${new Date().toISOString()} stats not written: ${e.message}`)

/**
 * Feeds a relay's statistics from its node (bridge.ts) and appends them every interval; the interval
 * does not keep the process alive. Statistics older than the retention are pruned at start and
 * once a day, apart from the ticks, which only append to the day's files; at start the files
 * that still hold peer ids are migrated first (migrateStats), logged through `log`. `loopDelay`,
 * `counters` and `probe` default to the node's, which hold the relay's last snapshot; before a
 * tick the node is asked to refresh it. Returns the statistics and a stop function.
 * @param {any} node the relay as bridge.ts shows it
 */
export function watchStats(
  node,
  {
    intervalMs = STATS_INTERVAL_MS,
    onError = defaultStatsError,
    loopDelay = node.loopDelay,
    probe = node.probe,
    counters = node.counters,
    log = console.log,
    ...o
  }: {
    file: string
    historyFile?: string
    intervalMs?: number
    now?: () => number
    onError?: (e: Error) => void
    history?: Buckets
    loopDelay?: { percentile(p: number): number; reset(): void; enable?(): void; disable?(): unknown }
    counters?: Counters
    probe?: () => Probe
    log?: (line: string) => void
  } = {} as never,
) {
  const stats = new RelayStats({ windowMs: intervalMs, loopDelay, probe, counters, ...o })
  node.services.pubsub.addEventListener('message', (e) => {
    const m = e.detail
    if (m.topic !== ANNOUNCE_TOPIC || !m.from) return
    const conn = node.getConnections(m.from)[0]
    if (conn) stats.record(m.from.toString(), transportOf(conn.remoteAddr), m.data)
  })
  // A replaced connection closes while the peer stays on its newer one.
  node.addEventListener('connection:close', (e) => {
    const { remotePeer, id } = e.detail
    if (!node.getConnections(remotePeer).some((c) => c.id !== id)) stats.forget(remotePeer.toString())
  })
  // The relay counts the bytes of each circuit and names the peers at its two ends.
  node.addEventListener('relayed', (e) => stats.recordRelayed(e.detail.peers, e.detail.bytes))
  // Ticks and prunes each one at a time, but apart: a prune never touches the day's files, and a
  // tick held behind a long rewrite of the old files would count its window late.
  const run = (job) => (stats.pending = stats.pending.then(job).catch(onError))
  const prune = () => (stats.pruning = stats.pruning.then(async () => void (await stats.prune())).catch(onError))
  const timer = setInterval(
    () =>
      run(async () => {
        // The counters, gauges and lag of this tick, straight from the relay.
        await node.refresh?.()
        await stats.tick(node.getConnections())
      }),
    intervalMs,
  )
  timer.unref?.()
  // Before the first tick and the first prune, so neither works on a file with peer ids.
  const migrated = run(async () => {
    for (const line of migrationLog(await stats.migrate())) log(`${new Date().toISOString()} ${line}`)
  })
  stats.pruning = migrated
  prune()
  const pruner = setInterval(prune, PRUNE_INTERVAL_MS)
  pruner.unref?.()
  return {
    stats,
    stop: () => {
      clearInterval(timer)
      clearInterval(pruner)
      loopDelay?.disable?.()
    },
  }
}
