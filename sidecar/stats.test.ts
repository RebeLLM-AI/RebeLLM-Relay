import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  ANNOUNCE_TOPIC,
  COUNTS_HEADER,
  HOT_HEADER,
  MAX_DAY_IDS,
  MAX_REPORTS,
  PEERS_HEADER,
  PRUNE_INTERVAL_MS,
  REPORTS_HEADER,
  RETENTION_MS,
  RelayStats,
  STATS_INTERVAL_MS,
  announceFields,
  announceVerdict,
  csvCell,
  decodeAnnounce,
  migrateStats,
  migrationLog,
  newCounters,
  pruneCsv,
  reportFields,
  watchStats,
} from './stats.ts'
import { DAY_MS, dailyFile, dailyFiles } from './daily.ts'
import { Buckets } from './history.ts'

/** Test doubles for the relay as bridge.ts shows it. */
interface MockConn {
  id?: string
  remotePeer: { toString(): string }
  remoteAddr: { toString(): string }
  timeline?: { open: number }
}
interface MockNode extends EventTarget {
  services: { pubsub: EventTarget }
  getConnections: (peer?: unknown) => unknown[]
  connect: (peer: string, addr: unknown) => MockConn
  close: (c: MockConn) => void
  announce: (peer: string, o: unknown) => void
  relayed: (peers: string[], bytes: number) => void
}

const T = new Date('2026-09-25T10:00:00.000Z')

const PEER = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo'
const b64 = (bytes) => Buffer.from(bytes).toString('base64')
const enc = (o) => new TextEncoder().encode(JSON.stringify(o))

test('rejects announces a browser would not decode, so gossip does not forward them', () => {
  const b64 = (n) => Buffer.alloc(n).toString('base64')
  const good = { v: 1, model: 'm', layers: 48, experts: 128, served: b64(768), addrs: [] }
  const enc = (o) => new TextEncoder().encode(JSON.stringify(o))
  assert.equal(announceVerdict(enc(good)), 'accept')
  assert.equal(announceVerdict(enc({ ...good, hot: b64(768), demand: b64(48 * 128 * 2) })), 'accept')
  for (const bad of [
    new TextEncoder().encode('junk'),
    enc({ ...good, v: 2 }),
    enc({ ...good, model: 7 }),
    enc({ ...good, layers: 0 }),
    enc({ ...good, layers: 1.5 }),
    enc({ ...good, layers: 2048, experts: 1024, served: b64(262144) }),
    enc({ ...good, served: b64(767) }),
    enc({ ...good, served: '*' }),
    enc({ ...good, hot: b64(10) }),
    enc({ ...good, demand: b64(10) }),
  ])
    assert.equal(announceVerdict(bad), 'reject')
})

test('an announce is parsed once for the validator, the statistics and the log', (t) => {
  const b64 = (n) => Buffer.alloc(n).toString('base64')
  const data = new TextEncoder().encode(JSON.stringify({ v: 1, model: 'm', layers: 2, experts: 4, served: b64(1) }))
  const parse = t.mock.method(JSON, 'parse')
  const stats = new RelayStats({ file: 'peers.csv', now: () => T.getTime() })
  assert.equal(announceVerdict(data), 'accept')
  assert.ok(stats.record('p', 'ws', data))
  assert.equal(announceFields(data)?.model, 'm')
  assert.equal(decodeAnnounce(data).layers, 2)
  assert.equal(parse.mock.callCount(), 1)
  // Keyed by the instance: the same bytes in another array are another message.
  assert.equal(announceVerdict(data.slice()), 'accept')
  assert.equal(parse.mock.callCount(), 2)
  // A rejected announce is remembered as rejected, also with one parse.
  const junk = new TextEncoder().encode('junk')
  assert.equal(announceVerdict(junk), 'reject')
  assert.equal(stats.record('p', 'ws', junk), false)
  assert.equal(decodeAnnounce(junk), null)
  assert.equal(parse.mock.callCount(), 3)
})

/** A node with connections to open and close, announces to deliver and relayed bytes to report. */
function statsNode() {
  const conns: MockConn[] = []
  const node = new EventTarget() as unknown as MockNode
  node.services = { pubsub: new EventTarget() }
  node.relayed = (peers, bytes) => node.dispatchEvent(new CustomEvent('relayed', { detail: { peers, bytes } }))
  node.getConnections = (peer: unknown) =>
    peer ? conns.filter((c) => c.remotePeer.toString() === String(peer)) : [...conns]
  let ids = 0
  node.connect = (peer: string, addr: unknown) => {
    const c = {
      id: `c${ids++}`,
      remotePeer: { toString: () => peer },
      remoteAddr: addr,
      timeline: { open: Date.now() },
    } as MockConn
    conns.push(c)
    return c
  }
  node.close = (c: MockConn) => {
    conns.splice(conns.indexOf(c), 1)
    node.dispatchEvent(new CustomEvent('connection:close', { detail: c }))
  }
  node.announce = (peer, o) =>
    node.services.pubsub.dispatchEvent(
      new CustomEvent('message', { detail: { topic: ANNOUNCE_TOPIC, from: { toString: () => peer }, data: enc(o) } }),
    )
  return node
}

const u16 = (xs) => Buffer.from(new Uint16Array(xs).buffer).toString('base64')
const statsAnnounce = (o) => ({ v: 1, model: 'qwen3-30b', layers: 2, experts: 4, addrs: [], ...o })
/** The eight empty network-only cells of a peer or total row. */
const E8 = ',,,,,,,,'

test('stats: every 5 minutes a total and a network row, the counts by field and the hot experts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-stats-'))
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: T.getTime() })
  const errors: Error[] = []
  const node = statsNode()
  const file = join(dir, 'peers.csv')
  // Nanoseconds, as Node's histogram reports them; a reset leaves Node's empty reading.
  const loopDelay = {
    ns: 35e6,
    resets: 0,
    disabled: false,
    percentile(p) {
      assert.equal(p, 99)
      return this.ns
    },
    reset() {
      this.resets++
      this.ns = 511
    },
    disable() {
      this.disabled = true
    },
  }
  const counters = newCounters()
  const probe = () => ({ rssBytes: 90e6, heapBytes: 40e6, reservations: 1, subscribers: 2 })
  const { stats, stop } = watchStats(node, { file, loopDelay, counters, probe, onError: (e) => errors.push(e) })
  // Every tick of this test falls on the same UTC day.
  const day = dailyFile(dir, 'peers', T.getTime())
  try {
    const a = node.connect('peerA', '/ip4/172.19.0.5/tcp/1/ws')
    const b = node.connect('peerB', '/ip4/172.19.0.5/tcp/2/ws')
    const A = statsAnnounce({
      served: b64([0b111]),
      demand: u16([5, 0, 0, 0, 0, 0, 0, 9]),
      loaded: 3,
      budgetBytes: 3e9,
      vramBytes: 4e9,
      ramBytes: 16e9,
      callsPerSec: 1.234,
      precision: 'f32',
      gpu: 'nvidia pascal',
      app: '0.0.1+abc',
    })
    node.announce('peerA', A)
    node.announce('peerB', statsAnnounce({ served: b64([0b110]), demand: u16([1, 0, 0, 0, 0, 0, 0, 0]) }))
    // Not kept: a peer without a connection here, an announce the validator rejects.
    node.announce('peerC', A)
    node.announce('peerA', { ...A, served: '*' })
    assert.deepEqual([...stats.peers.keys()], ['peerA', 'peerB'])
    // A relayed stream counts what its peer sends and what goes to it. B reserved the slot,
    // A dialled through: both ends move the bytes.
    node.relayed(['peerB', 'peerA'], 100)
    node.relayed(['peerB', 'peerA'], 50)
    // What the relay counts: the stream and its bytes, two connections opened and a token issued.
    counters.relayedStreams++
    counters.relayedBytes += 150
    counters.connectionsOpened += 2
    counters.tokens++

    t.mock.timers.tick(STATS_INTERVAL_MS)
    await stats.pending
    const t1 = '2026-09-25T10:05:00.000Z'
    // Replicas [1, 2, 2, 0, 0, 0, 0, 0]: min 0, median 0, max 2, five with none. A p99 of 35 ms
    // is 15 ms beyond the 20 ms sampling interval. Only the network row fills the last eight,
    // only the total row the summed calls per second. No row names a peer.
    const first = [
      PEERS_HEADER,
      `${t1},total,,,,,4000000000,3000000000,3,5,2,,16000000000,300,${E8},1.23`,
      `${t1},network,2,2,0,300,0,0,2,5,150,,,,15,90000000,40000000,1,2,2,1,0,1,`,
    ]
    assert.deepEqual((await readFile(day, 'utf8')).split('\n'), [...first, ''])
    assert.equal(loopDelay.resets, 1)
    const hot = dailyFile(dir, 'hot', T.getTime())
    assert.deepEqual((await readFile(hot, 'utf8')).split('\n'), [HOT_HEADER, `${t1},1,3,9`, `${t1},0,0,6`, ''])
    // The tick's nodes and the day's so far are the same two; no report yet. Most first, unknown empty.
    const nodes = (set) => [
      `${t1},${set},all,,2`,
      `${t1},${set},gpu,,1`,
      `${t1},${set},gpu,"nvidia pascal",1`,
      `${t1},${set},precision,,1`,
      `${t1},${set},precision,"f32",1`,
      `${t1},${set},app,,1`,
      `${t1},${set},app,"0.0.1+abc",1`,
      `${t1},${set},transport,"ws",2`,
      `${t1},${set},model,"qwen3-30b",2`,
      `${t1},${set},budget,"2-4GiB",1`,
      `${t1},${set},budget,"<1GiB",1`,
    ]
    const countsDay = dailyFile(dir, 'counts', T.getTime())
    const firstCounts = [COUNTS_HEADER, ...nodes('live'), ...nodes('nodes'), `${t1},reporters,all,,0`]
    assert.deepEqual((await readFile(countsDay, 'utf8')).split('\n'), [...firstCounts, ''])

    // A replaced connection closes while the peer stays on the new one; B leaves; A announces again.
    node.connect('peerA', '/ip4/172.19.0.5/tcp/3/ws')
    node.close(a)
    node.close(b)
    assert.deepEqual([...stats.peers.keys()], ['peerA'])
    t.mock.timers.tick(2 * 60_000)
    node.announce('peerA', A)
    // The counts start from the previous tick.
    counters.refused += 3
    t.mock.timers.tick(3 * 60_000)
    await stats.pending
    const t2 = '2026-09-25T10:10:00.000Z'
    const second = [
      `${t2},total,,,,,4000000000,3000000000,3,3,1,,16000000000,0,${E8},1.23`,
      `${t2},network,1,1,0,300,0,0,1,5,0,,,,0,90000000,40000000,1,2,0,0,3,0,`,
    ]
    assert.deepEqual((await readFile(day, 'utf8')).split('\n'), [...first, ...second, ''])
    // B left the tick but stays in the day's distinct nodes.
    const alls = (await readFile(countsDay, 'utf8')).split('\n').filter((l) => l.includes(',all,'))
    assert.deepEqual(alls.slice(3), [`${t2},live,all,,1`, `${t2},nodes,all,,2`, `${t2},reporters,all,,0`])

    // A connected peer silent for a whole window is left out.
    loopDelay.ns = 130e6
    t.mock.timers.tick(STATS_INTERVAL_MS)
    await stats.pending
    const t3 = '2026-09-25T10:15:00.000Z'
    const third = [
      `${t3},total,,,,,0,0,0,0,0,,0,0,${E8},0`,
      `${t3},network,1,1,0,600,,,,,0,,,,110,90000000,40000000,1,2,0,0,0,0,`,
    ]
    assert.deepEqual((await readFile(day, 'utf8')).split('\n'), [...first, ...second, ...third, ''])
    const hotLines = (await readFile(hot, 'utf8')).split('\n')
    assert.deepEqual(hotLines, [HOT_HEADER, `${t1},1,3,9`, `${t1},0,0,6`, `${t2},1,3,9`, `${t2},0,0,5`, ''])
    assert.deepEqual(errors, [])

    // Stopped: no more ticks, and the histogram stops sampling.
    stop()
    assert.equal(loopDelay.disabled, true)
    t.mock.timers.tick(STATS_INTERVAL_MS)
    await stats.pending
    assert.equal((await readFile(day, 'utf8')).split('\n').length, first.length + second.length + third.length + 1)
    // The base path only names the directory: nothing is written to it.
    await assert.rejects(readFile(file), { code: 'ENOENT' })
  } finally {
    stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('stats: the 256 hottest experts, most demand first, only those with any', () => {
  const stats = new RelayStats({ file: 'peers.csv', now: () => T.getTime() })
  const demand = Array.from({ length: 512 }, (_, i) => (i < 300 ? i + 1 : 0))
  const served = b64(new Uint8Array(64))
  assert.ok(stats.record('p', 'ws', enc(statsAnnounce({ layers: 2, experts: 256, served, demand: u16(demand) }))))
  const { hot, peers } = stats.lines([])
  assert.equal(hot.length, 256)
  assert.equal(hot[0], `${T.toISOString()},1,43,300`)
  assert.equal(hot[255], `${T.toISOString()},0,44,45`)
  // Nobody serves anything: every expert has no replica.
  // Without counters and a probe the last eight stay empty.
  assert.equal(peers.at(-1), `${T.toISOString()},network,0,0,0,,0,0,0,512,0,,,,${E8},`)
})

test('stats: the network row carries the p99 event-loop lag beyond the sampling interval, in whole ms', () => {
  const at = (ns) => ({ percentile: () => ns, reset() {} })
  const lag = (ns) => new RelayStats({ file: 'peers.csv', now: () => T.getTime(), loopDelay: at(ns) })
  const col = PEERS_HEADER.split(',').indexOf('loop_lag_ms')
  assert.equal(lag(20.3e6).lines([]).peers.at(-1)!.split(',')[col], '0')
  assert.equal(lag(47.6e6).lines([]).peers.at(-1)!.split(',')[col], '28')
  // An empty histogram reads 0 or a few ns: no lag, never a negative one.
  assert.equal(lag(511).loopLagMs(), 0)
  assert.equal(new RelayStats({ file: 'peers.csv' }).loopLagMs(), undefined)
})

test("stats: a peer's strings are quoted in the counts, so they add no column, row or formula", () => {
  assert.equal(csvCell('a"b,c'), '"a""b,c"')
  assert.equal(csvCell('x\n2026-09-25T10:00:00.000Z,total'), '"x 2026-09-25T10:00:00.000Z,total"')
  assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`)
  assert.equal(csvCell(1.5), '1.5')
  assert.equal(csvCell(undefined), '')
  const stats = new RelayStats({ file: 'peers.csv', now: () => T.getTime() })
  const hostile = statsAnnounce({
    served: b64([1]),
    model: 'm","x',
    gpu: '+1\r\nfake,row',
    precision: '@SUM(A1)',
    app: 'v"1',
    budgetBytes: -5,
    loaded: 'many',
  })
  assert.ok(stats.record('p"1', 'ws', enc(hostile)))
  const { peers, counts } = stats.lines([])
  assert.ok(!peers.join('\n').includes('p""1'))
  const time = T.toISOString()
  assert.deepEqual(counts.slice(0, 7), [
    `${time},live,all,,1`,
    `${time},live,gpu,"'+1  fake,row",1`,
    `${time},live,precision,"'@SUM(A1)",1`,
    `${time},live,app,"v""1",1`,
    `${time},live,transport,"ws",1`,
    `${time},live,model,"m"",""x",1`,
    `${time},live,budget,"<1GiB",1`,
  ])
  assert.deepEqual(announceFields(enc(hostile)), {
    model: 'm","x',
    gpu: '+1\r\nfake,row',
    precision: '@SUM(A1)',
    vramBytes: undefined,
    budgetBytes: 0,
    loaded: 0,
    served: 1,
    callsPerSec: 0,
    app: 'v"1',
    ramBytes: undefined,
  })
  assert.equal(announceFields(enc({ ...hostile, served: '*' })), null)
  assert.equal(announceFields(new TextEncoder().encode('junk')), null)
})

/** A usage report as browsers send it. */
const usageReport = (o = {}) => ({
  v: 1,
  at: 1_790_000_000_000,
  app: '0.0.1+abc',
  machine: {
    gpu: 'nvidia pascal',
    precision: 'f32',
    vramBytes: 8 * 2 ** 30,
    budgetBytes: 2 * 2 ** 30,
    phone: false,
    browser: 'chrome',
    os: 'windows',
  },
  trunk: {
    requests: 3,
    tokens: 420,
    prefillTokPerSec: 812.5,
    decodeTokPerSec: 6.25,
    missesPerToken: 1.5,
    lookaheadRate: 0.8,
    remoteP50Ms: 42,
    remoteP95Ms: 120.5,
    waitMsPerToken: 30.2,
    contextP50: 5120,
    stops: { eos: 2, length: 1, loop: 0, abort: 0 },
    toolCalls: 2,
    loadMs: 64000,
    loadedFromStorage: true,
    failures: { oom: 0, wasm: 0, unavailable: 1, other: 0 },
    parks: 1,
    netUpPerToken: 169984,
    netDownPerToken: 172032,
  },
  node: {
    calls: 900,
    callP50Ms: 3.5,
    errors: 1,
    checksPassed: 12,
    checksFailed: 0,
    markedDown: 1,
    expertLoadP50Ms: 210,
  },
  ...o,
})
const REPORT_CELLS =
  '"0.0.1+abc","nvidia pascal","f32",8589934592,2147483648,0,"chrome","windows",' +
  '3,420,812.5,6.25,1.5,0.8,42,120.5,30.2,5120,2,1,0,0,2,64000,1,0,0,1,0,1,900,3.5,1,12,0,1,210,169984,172032'

test('reports: one flat row per report without its peer, at the tick, header once, in the order of the report', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-reports-'))
  t.mock.timers.enable({ apis: ['Date'], now: T.getTime() })
  try {
    const stats = new RelayStats({ file: join(dir, 'peers.csv'), now: () => Date.now() })
    assert.ok(stats.recordReport('peerA', enc(usageReport())))
    t.mock.timers.tick(1500)
    // Missing numbers are 0 and unknown families "other"; nothing that does not decode is kept.
    assert.ok(
      stats.recordReport('peerB', enc({ v: 1, machine: { browser: 'edge', os: 'beos' }, trunk: { tokens: 5 } })),
    )
    assert.equal(stats.recordReport('peerC', enc(usageReport({ v: 2 }))), false)
    assert.equal(stats.recordReport('peerC', enc(usageReport({ pad: 'x'.repeat(3000) }))), false)
    await stats.tick([])
    const file = dailyFile(dir, 'reports', T.getTime())
    const zeros = (n) => Array(n).fill(0).join(',')
    // Both carry the tick's time, not their arrival's.
    const first = [
      REPORTS_HEADER,
      `2026-09-25T10:00:01.500Z,${REPORT_CELLS}`,
      `2026-09-25T10:00:01.500Z,,,,0,0,0,"other","other",0,5,${zeros(29)}`,
    ]
    assert.deepEqual((await readFile(file, 'utf8')).split('\n'), [...first, ''])
    const reporters = (await readFile(dailyFile(dir, 'counts', T.getTime()), 'utf8'))
      .split('\n')
      .filter((l) => l.includes(',reporters,'))
      .map((l) => l.slice(25))
    assert.deepEqual(reporters, [
      'reporters,all,,2',
      'reporters,app,,1',
      'reporters,app,"0.0.1+abc",1',
      'reporters,gpu,,1',
      'reporters,gpu,"nvidia pascal",1',
      'reporters,precision,,1',
      'reporters,precision,"f32",1',
      'reporters,phone,"desktop",2',
      'reporters,browser,"chrome",1',
      'reporters,browser,"other",1',
      'reporters,os,"other",1',
      'reporters,os,"windows",1',
    ])
    assert.equal(
      REPORTS_HEADER,
      'time,app,gpu,precision,vram_bytes,budget_bytes,phone,browser,os,' +
        'requests,tokens,prefill_tok_per_sec,decode_tok_per_sec,misses_per_token,lookahead_rate,' +
        'remote_p50_ms,remote_p95_ms,wait_ms_per_token,context_p50,stops_eos,stops_length,stops_loop,stops_abort,' +
        'tool_calls,load_ms,loaded_from_storage,failures_oom,failures_wasm,failures_unavailable,failures_other,parks,' +
        'node_calls,node_call_p50_ms,node_errors,node_checks_passed,node_checks_failed,node_marked_down,' +
        'node_expert_load_p50_ms,net_up_per_token,net_down_per_token',
    )
    assert.equal(REPORTS_HEADER.split(',').length, first[1].split(',').length)
    // The next tick adds only what came since.
    await stats.tick([])
    assert.ok(stats.recordReport('peerA', enc(usageReport())))
    await stats.tick([])
    const lines = (await readFile(file, 'utf8')).split('\n')
    assert.deepEqual(lines.slice(0, 3), first)
    assert.equal(lines.length, 5)
    assert.equal(lines.filter((l) => l === REPORTS_HEADER).length, 1)
    // peerA reported again the same day: still two reporters.
    const counts = (await readFile(dailyFile(dir, 'counts', T.getTime()), 'utf8')).split('\n')
    assert.ok(counts.at(-2)!.startsWith(`${new Date(Date.now()).toISOString()},reporters,os,`))
    assert.equal(counts.filter((l) => l.endsWith(',reporters,all,,2')).length, 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("reports: a peer's strings are quoted like in peers.csv, and the rows between ticks are bounded", () => {
  const hostile: { machine: Record<string, unknown>; trunk: Record<string, unknown> } = usageReport({ app: '=1+2' })
  hostile.machine = { ...hostile.machine, gpu: '@x,"y"', precision: 'f64', phone: true }
  hostile.trunk = { ...hostile.trunk, requests: -1, tokens: 'many' }
  const cells = reportFields(enc(hostile))!
  const machine = ['=1+2', '@x,"y"', undefined, 8589934592, 2147483648, 1, 'chrome', 'windows']
  assert.deepEqual(cells.slice(0, 10), [...machine, 0, 0])
  const stats = new RelayStats({ file: 'peers.csv', now: () => T.getTime() })
  assert.ok(stats.recordReport('p"1', enc(hostile)))
  assert.match(stats.reports[0], /^"'=1\+2","'@x,""y""",,/)
  assert.deepEqual(stats.reporting.get('p"1'), {
    app: '=1+2',
    gpu: '@x,"y"',
    precision: undefined,
    phone: 'phone',
    browser: 'chrome',
    os: 'windows',
  })
  assert.equal(reportFields(new TextEncoder().encode('junk')), null)
  stats.reports.length = MAX_REPORTS
  assert.equal(stats.recordReport('p', enc(usageReport())), false)
  assert.equal(stats.reports.length, MAX_REPORTS)
})

test("stats: a tick appends to its UTC day's files, header once; the next UTC day starts new ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-daily-'))
  let now = Date.parse('2026-09-28T23:55:00.000Z')
  const stats = new RelayStats({ file: join(dir, 'peers.csv'), now: () => now })
  const rows = async (name) => (await readFile(join(dir, name), 'utf8')).split('\n')
  try {
    await stats.tick([])
    now += STATS_INTERVAL_MS - 1
    await stats.tick([])
    const first = await rows('peers-2026-09-28.csv')
    assert.equal(first[0], PEERS_HEADER)
    assert.equal(first.filter((l) => l === PEERS_HEADER).length, 1)
    assert.deepEqual(
      first.filter((l) => l.includes(',total,')).map((l) => l.slice(0, 24)),
      ['2026-09-28T23:55:00.000Z', '2026-09-28T23:59:59.999Z'],
    )
    const before = await readFile(join(dir, 'peers-2026-09-28.csv'), 'utf8')
    now += 1
    await stats.tick([])
    const t = '2026-09-29T00:00:00.000Z'
    assert.deepEqual(await rows('peers-2026-09-29.csv'), [
      PEERS_HEADER,
      `${t},total,,,,,0,0,0,0,0,,0,0,${E8},0`,
      `${t},network,0,0,0,,,,,,0,,,,${E8},`,
      '',
    ])
    assert.equal(await readFile(join(dir, 'peers-2026-09-28.csv'), 'utf8'), before)
    assert.deepEqual(await rows('hot-2026-09-29.csv'), [HOT_HEADER, ''])
    assert.deepEqual(await rows('reports-2026-09-29.csv'), [REPORTS_HEADER, ''])
    assert.deepEqual((await readdir(dir)).sort(), [
      'counts-2026-09-28.csv',
      'counts-2026-09-29.csv',
      'hot-2026-09-28.csv',
      'hot-2026-09-29.csv',
      'peers-2026-09-28.csv',
      'peers-2026-09-29.csv',
      'reports-2026-09-28.csv',
      'reports-2026-09-29.csv',
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('stats: daily files past the retention are deleted unread at start and once a day; newer ones and other files stay', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-prune-daily-'))
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: T.getTime() })
  const errors: Error[] = []
  const node = statsNode()
  const day = (d) => dailyFile(dir, 'peers', T.getTime() - d * DAY_MS)
  // 13 months back; the day that began just over 12 months back, whose later rows are a few
  // hours short of it (a day early rather than late); the next day; yesterday.
  const old = [day(396), dailyFile(dir, 'hot', T.getTime() - 396 * DAY_MS), day(365)]
  const kept = [day(364), day(1)]
  const others = ['relay-key.bin', 'history.json', 'notes.csv', 'peers-2025-02-31.csv'].map((n) => join(dir, n))
  // Not a CSV at all: deleting must not read it.
  for (const f of [...old, ...kept]) await writeFile(f, 'unread')
  for (const f of others) await writeFile(f, 'x')
  const { stats, stop } = watchStats(node, { file: join(dir, 'peers.csv'), onError: (e) => errors.push(e) })
  try {
    await stats.pruning
    for (const f of old) await assert.rejects(stat(f), { code: 'ENOENT' }, f)
    for (const f of [...kept, ...others]) await stat(f)
    assert.equal(await readFile(day(364), 'utf8'), 'unread')
    // A day later the next day has gone the same way; yesterday's and the others stay.
    t.mock.timers.tick(PRUNE_INTERVAL_MS)
    await Promise.all([stats.pending, stats.pruning])
    await assert.rejects(stat(day(364)), { code: 'ENOENT' })
    for (const f of [day(1), ...others]) await stat(f)
    assert.deepEqual(errors, [])
    const r = await stats.prune(T.getTime() + 400 * DAY_MS)
    assert.ok(r.deleted.includes(day(1)))
  } finally {
    stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('stats: the files from before the daily layout get no rows, lose their old ones daily and go once empty; history.json follows each tick', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-prune-'))
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: T.getTime() })
  const errors: Error[] = []
  const node = statsNode()
  const file = join(dir, 'peers.csv')
  const old = new Date(T.getTime() - RETENTION_MS - 60_000).toISOString()
  const fresh = new Date(T.getTime() - RETENTION_MS + 60_000).toISOString()
  await writeFile(file, `${PEERS_HEADER}\n${old},total,,,,,1,1,1,1,1,\n${fresh},total,,,,,2,2,2,2,2,\nnot a time,x\n`)
  await writeFile(join(dir, 'hot.csv'), `${HOT_HEADER}\n${old},0,1,5\n${fresh},0,2,6\n`)
  await writeFile(join(dir, 'reports.csv'), `${REPORTS_HEADER}\n${old},"p"\n`)
  const history = new Buckets()
  const { stats, stop } = watchStats(node, { file, history, onError: (e) => errors.push(e) })
  try {
    await stats.pruning
    const rows = async (f) => (await readFile(join(dir, f), 'utf8')).split('\n')
    assert.deepEqual(await rows('peers.csv'), [PEERS_HEADER, `${fresh},total,,,,,2,2,2,2,2,`, 'not a time,x', ''])
    assert.deepEqual(await rows('hot.csv'), [HOT_HEADER, `${fresh},0,2,6`, ''])
    // Its only row was old: nothing is left to keep, and nothing appends to it again.
    await assert.rejects(stat(join(dir, 'reports.csv')), { code: 'ENOENT' })
    assert.equal(await pruneCsv(join(dir, 'none.csv'), 0), undefined)
    // a tick appends to the day's files only and saves the history beside them
    t.mock.timers.tick(STATS_INTERVAL_MS)
    await stats.pending
    assert.deepEqual(await rows('peers.csv'), [PEERS_HEADER, `${fresh},total,,,,,2,2,2,2,2,`, 'not a time,x', ''])
    assert.ok((await rows(`peers-${T.toISOString().slice(0, 10)}.csv`)).some((l) => l.includes(',total,')))
    const saved = JSON.parse(await readFile(join(dir, 'history.json'), 'utf8'))
    assert.equal(saved.v, 1)
    assert.equal(saved.upTo, T.getTime() + STATS_INTERVAL_MS)
    assert.equal(saved.open.n, 1)
    // a day later the row that was fresh has aged out: hot.csv is empty and goes, peers.csv
    // keeps the row it cannot date
    t.mock.timers.tick(PRUNE_INTERVAL_MS)
    await Promise.all([stats.pending, stats.pruning])
    assert.deepEqual(await rows('peers.csv'), [PEERS_HEADER, 'not a time,x', ''])
    await assert.rejects(stat(join(dir, 'hot.csv')), { code: 'ENOENT' })
    const daily = await dailyFiles(dir)
    const totals = await Promise.all(
      daily
        .filter((f) => f.kind === 'peers')
        .map(async (f) => (await readFile(f.path, 'utf8')).split(',total,').length - 1),
    )
    assert.ok(totals.reduce((a, b) => a + b, 0) >= 288)
    assert.deepEqual(errors, [])
  } finally {
    stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('pruneCsv: the rows dropped and the dated or undated rows kept after the header', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-prune-csv-'))
  try {
    const f = join(dir, 'x.csv')
    await writeFile(f, `${HOT_HEADER}\n2020-01-01T00:00:00.000Z,0,1,5\n2030-01-01T00:00:00.000Z,0,1,5\n\n`)
    assert.deepEqual(await pruneCsv(f, Date.parse('2025-01-01')), { dropped: 1, kept: 1 })
    assert.deepEqual(await pruneCsv(f, Date.parse('2031-01-01')), { dropped: 1, kept: 0 })
    assert.equal(await readFile(f, 'utf8'), `${HOT_HEADER}\n\n`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('stats: a tick is not held behind a running prune', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-prune-apart-'))
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: T.getTime() })
  const { stats, stop } = watchStats(statsNode(), { file: join(dir, 'peers.csv') })
  // The start's prune looks the method up when it runs, after this.
  let release: (value?: unknown) => void = () => {}
  stats.prune = () =>
    new Promise<{ deleted: string[]; dropped: number }>((resolve) => {
      release = resolve as (value?: unknown) => void
    })
  try {
    t.mock.timers.tick(STATS_INTERVAL_MS)
    await stats.pending
    const rows = (await readFile(dailyFile(dir, 'peers', T.getTime()), 'utf8')).split('\n')
    assert.equal(rows[1], `${new Date(T.getTime() + STATS_INTERVAL_MS).toISOString()},total,,,,,0,0,0,0,0,,0,0,${E8},0`)
  } finally {
    release()
    await stats.pruning
    stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('stats: the day counts hold each node and reporter once, start again on a new UTC day and stop at the cap', () => {
  let now = Date.parse('2026-09-28T23:55:00.000Z')
  const stats = new RelayStats({ file: 'peers.csv', now: () => now })
  const alls = () =>
    stats
      .lines([])
      .counts.filter((l) => l.includes(',all,'))
      .map((l) => l.slice(25))
  const announce = enc(statsAnnounce({ served: b64([1]) }))
  stats.record('a', 'ws', announce)
  stats.record('b', 'ws', announce)
  stats.recordReport('a', enc(usageReport()))
  stats.recordReport('a', enc(usageReport()))
  assert.deepEqual(alls(), ['live,all,,2', 'nodes,all,,2', 'reporters,all,,1'])
  // As a tick: the reporters since it are in the day's set.
  stats.reporting.clear()
  stats.forget('b')
  now += 60_000
  assert.deepEqual(alls(), ['live,all,,1', 'nodes,all,,2', 'reporters,all,,1'])
  // Midnight UTC: the day's ids go, only the tick's node is counted again.
  now = Date.parse('2026-09-29T00:00:00.000Z')
  assert.deepEqual(alls(), ['live,all,,1', 'nodes,all,,1', 'reporters,all,,0'])
  assert.equal(stats.day.key, '2026-09-29')
  // A full set takes no new id but still updates the ones it has.
  stats.day.nodes = new Map(Array.from({ length: MAX_DAY_IDS - 1 }, (_, i) => [`x${i}`, {}]))
  stats.day.nodes.set('a', {})
  stats.record('c', 'wss', announce)
  assert.deepEqual(alls(), ['live,all,,2', `nodes,all,,${MAX_DAY_IDS}`, 'reporters,all,,0'])
  assert.equal(stats.day.nodes.has('c'), false)
  assert.equal(stats.day.nodes.get('a')!.transport, 'ws')
})

const PEER2 = 'QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N'
const OLD_PEERS_HEADER = PEERS_HEADER.replace(',row,', ',peer,').replace(',calls_per_sec_sum', '')
const OLD_REPORTS_HEADER = REPORTS_HEADER.replace('time,', 'time,peer,')
/** A per-node row as the relay wrote it before the files lost the peer ids. */
const nodeLine = (time, id, transport, gpu, budget) =>
  `${time},"${id}","${transport}","qwen3-30b",${gpu},"f32",4000000000,${budget},3,3,1.23,"0.0.1+abc",16000000000,150,${E8}`
const totalLine = (time) => `${time},total,,,,,4000000000,3000000000,3,3,1,,16000000000,150,${E8}`
const networkLine = (time) => `${time},network,1,1,0,300,0,0,1,5,150,,,,15,90000000,40000000,1,2,2,1,0,1`

/** Old statistics files of several days, as a relay before this change left them. */
async function oldStats(dir) {
  const files = {
    'peers-2026-09-24.csv': [
      OLD_PEERS_HEADER,
      nodeLine('2026-09-24T10:00:00.000Z', PEER, 'ws', '"nvidia pascal"', 3e9),
      totalLine('2026-09-24T10:00:00.000Z'),
      networkLine('2026-09-24T10:00:00.000Z'),
      nodeLine('2026-09-24T10:05:00.000Z', PEER2, 'wss', '', 0),
      nodeLine('2026-09-24T10:05:00.000Z', PEER, 'ws', '"nvidia pascal"', 3e9),
      totalLine('2026-09-24T10:05:00.000Z'),
    ],
    'reports-2026-09-24.csv': [
      OLD_REPORTS_HEADER,
      `2026-09-24T10:07:00.000Z,"${PEER}",${REPORT_CELLS}`,
      `2026-09-24T10:08:00.000Z,"${PEER}",${REPORT_CELLS}`,
    ],
    // A day whose counts file a run already wrote.
    'peers-2026-09-23.csv': [OLD_PEERS_HEADER, nodeLine('2026-09-23T10:00:00.000Z', PEER, 'ws', '', 0)],
    'counts-2026-09-23.csv': [COUNTS_HEADER, '2026-09-23T10:00:00.000Z,nodes,all,,7'],
    // Today, written by this code and then by an older one after a rollback; an app named like a
    // peer id has no cell more and stays.
    'reports-2026-09-25.csv': [
      REPORTS_HEADER,
      `2026-09-25T09:00:00.000Z,${REPORT_CELLS}`,
      `2026-09-25T09:01:00.000Z,"${PEER2}",${REPORT_CELLS}`,
      `2026-09-25T09:05:00.000Z,"${PEER.replace('Q', 'R')}"${REPORT_CELLS.slice(REPORT_CELLS.indexOf(','))}`,
    ],
    // Past the retention: left to the prune.
    'peers-2024-06-01.csv': [OLD_PEERS_HEADER, nodeLine('2024-06-01T10:00:00.000Z', PEER, 'ws', '', 0)],
    'peers.csv': [
      OLD_PEERS_HEADER,
      nodeLine('2024-01-01T00:00:00.000Z', PEER2, 'ws', '', 0),
      nodeLine('2026-09-20T12:00:00.000Z', PEER, 'webrtc', '', 4e10),
      totalLine('2026-09-20T12:00:00.000Z'),
      'not a time,x',
    ],
    'reports.csv': [OLD_REPORTS_HEADER, `2026-09-20T13:00:00.000Z,"${PEER2}",${REPORT_CELLS}`],
  }
  for (const [name, lines] of Object.entries(files)) await writeFile(join(dir, name), `${lines.join('\n')}\n`)
  return files
}

/** Every file of a directory by name. */
async function contents(dir): Promise<Record<string, string>> {
  const names = (await readdir(dir)).sort()
  return Object.fromEntries(await Promise.all(names.map(async (n) => [n, await readFile(join(dir, n), 'utf8')])))
}

const machine = (t, set) => [
  `${t},${set},app,"0.0.1+abc",1`,
  `${t},${set},gpu,"nvidia pascal",1`,
  `${t},${set},precision,"f32",1`,
  `${t},${set},phone,"desktop",1`,
  `${t},${set},browser,"chrome",1`,
  `${t},${set},os,"windows",1`,
]

test('migrateStats: counts per day first, then the files without peer ids; a second run changes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-migrate-'))
  try {
    const old = await oldStats(dir)
    const legacy = { peers: join(dir, 'peers.csv'), reports: join(dir, 'reports.csv') }
    const r = await migrateStats(dir, legacy, T.getTime() - RETENTION_MS)
    const after = await contents(dir)
    const lines = (n) => after[n].split('\n')
    // The day's last row with an id stamps its counts; each id once, its latest fields.
    const t24 = '2026-09-24T10:08:00.000Z'
    assert.deepEqual(lines('counts-2026-09-24.csv'), [
      COUNTS_HEADER,
      `${t24},nodes,all,,2`,
      `${t24},nodes,gpu,,1`,
      `${t24},nodes,gpu,"nvidia pascal",1`,
      `${t24},nodes,precision,"f32",2`,
      `${t24},nodes,app,"0.0.1+abc",2`,
      `${t24},nodes,transport,"ws",1`,
      `${t24},nodes,transport,"wss",1`,
      `${t24},nodes,model,"qwen3-30b",2`,
      `${t24},nodes,budget,"2-4GiB",1`,
      `${t24},nodes,budget,"<1GiB",1`,
      `${t24},reporters,all,,1`,
      ...machine(t24, 'reporters'),
      '',
    ])
    assert.equal(after['counts-2026-09-23.csv'], `${old['counts-2026-09-23.csv'].join('\n')}\n`)
    const t20 = '2026-09-20T13:00:00.000Z'
    assert.deepEqual(lines('counts-2026-09-20.csv'), [
      COUNTS_HEADER,
      `${t20},nodes,all,,1`,
      `${t20},nodes,gpu,,1`,
      `${t20},nodes,precision,"f32",1`,
      `${t20},nodes,app,"0.0.1+abc",1`,
      `${t20},nodes,transport,"webrtc",1`,
      `${t20},nodes,model,"qwen3-30b",1`,
      `${t20},nodes,budget,"32GiB+",1`,
      `${t20},reporters,all,,1`,
      ...machine(t20, 'reporters'),
      '',
    ])
    const t25 = '2026-09-25T09:01:00.000Z'
    assert.deepEqual(lines('counts-2026-09-25.csv'), [
      COUNTS_HEADER,
      `${t25},reporters,all,,1`,
      ...machine(t25, 'reporters'),
      '',
    ])
    // No day file for the row past the retention.
    assert.deepEqual(
      Object.keys(after).filter((n) => n.startsWith('counts-')),
      ['counts-2026-09-20.csv', 'counts-2026-09-23.csv', 'counts-2026-09-24.csv', 'counts-2026-09-25.csv'],
    )
    // Only the total and network rows stay, under the current header; undated rows stay too.
    assert.deepEqual(lines('peers-2026-09-24.csv'), [
      PEERS_HEADER,
      totalLine('2026-09-24T10:00:00.000Z'),
      networkLine('2026-09-24T10:00:00.000Z'),
      totalLine('2026-09-24T10:05:00.000Z'),
      '',
    ])
    assert.deepEqual(lines('peers-2026-09-23.csv'), [PEERS_HEADER, ''])
    assert.deepEqual(lines('peers.csv'), [PEERS_HEADER, totalLine('2026-09-20T12:00:00.000Z'), 'not a time,x', ''])
    assert.deepEqual(lines('reports-2026-09-24.csv'), [
      REPORTS_HEADER,
      `2026-09-24T10:07:00.000Z,${REPORT_CELLS}`,
      `2026-09-24T10:08:00.000Z,${REPORT_CELLS}`,
      '',
    ])
    assert.deepEqual(lines('reports.csv'), [REPORTS_HEADER, `${t20},${REPORT_CELLS}`, ''])
    const today = old['reports-2026-09-25.csv']
    assert.deepEqual(lines('reports-2026-09-25.csv'), [today[0], today[1], `${t25},${REPORT_CELLS}`, today[3], ''])
    assert.equal(after['peers-2024-06-01.csv'], `${old['peers-2024-06-01.csv'].join('\n')}\n`)
    for (const [n, text] of Object.entries(after))
      if (n !== 'peers-2024-06-01.csv') assert.ok(!text.includes(PEER) && !text.includes(PEER2), n)
    assert.deepEqual(
      r.counts.map((c) => [c.path.slice(dir.length + 1), c.nodes, c.reporters, c.written]),
      [
        ['counts-2026-09-20.csv', 1, 1, true],
        ['counts-2026-09-23.csv', 1, 0, false],
        ['counts-2026-09-24.csv', 2, 1, true],
        ['counts-2026-09-25.csv', 0, 1, true],
      ],
    )
    assert.deepEqual(r.files.map((f) => [f.path.slice(dir.length + 1), f.kind, f.rows]).sort(), [
      ['peers-2026-09-23.csv', 'peers', 1],
      ['peers-2026-09-24.csv', 'peers', 3],
      ['peers.csv', 'peers', 2],
      ['reports-2026-09-24.csv', 'reports', 2],
      ['reports-2026-09-25.csv', 'reports', 1],
      ['reports.csv', 'reports', 1],
    ])
    assert.deepEqual(migrationLog(r).slice(0, 2), [
      'stats migrated: counts-2026-09-20.csv written (1 nodes, 1 reporters)',
      'stats migrated: counts-2026-09-23.csv kept (1 nodes, 0 reporters)',
    ])
    assert.ok(migrationLog(r).includes('stats migrated: peers-2026-09-24.csv without peer ids (3 rows)'))
    // Done: nothing to do, nothing touched.
    assert.deepEqual(await migrateStats(dir, legacy, T.getTime() - RETENTION_MS), { files: [], counts: [] })
    assert.deepEqual(await contents(dir), after)
    assert.deepEqual(await migrateStats(join(dir, 'none'), {}, 0), { files: [], counts: [] })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('stats: watchStats migrates before the first tick and prune and logs it; no file then holds a peer id', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-migrate-watch-'))
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: T.getTime() })
  await oldStats(dir)
  const logged: string[] = []
  const errors: Error[] = []
  const node = statsNode()
  const { stats, stop } = watchStats(node, {
    file: join(dir, 'peers.csv'),
    log: (l) => logged.push(l),
    onError: (e) => errors.push(e),
  })
  try {
    node.connect(PEER, '/ip4/172.19.0.5/tcp/1/ws')
    node.announce(PEER, statsAnnounce({ served: b64([1]) }))
    await stats.pruning
    assert.equal(logged.length, 10)
    assert.ok(
      logged.every((l) => l.startsWith(`${T.toISOString()} stats migrated: `)),
      logged.join('\n'),
    )
    t.mock.timers.tick(STATS_INTERVAL_MS)
    await stats.pending
    const after = await contents(dir)
    // The prune took the file past the retention; the tick appended to today's counts.
    assert.equal(after['peers-2024-06-01.csv'], undefined)
    assert.ok(after['counts-2026-09-25.csv'].includes('2026-09-25T10:05:00.000Z,nodes,all,,1'))
    for (const [n, text] of Object.entries(after)) assert.ok(!text.includes(PEER) && !text.includes(PEER2), n)
    assert.deepEqual(errors, [])
  } finally {
    stop()
    await rm(dir, { recursive: true, force: true })
  }
})
