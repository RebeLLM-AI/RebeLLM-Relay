import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  MAX_DAYS,
  PEERS_COLUMNS,
  REPORTS_COLUMNS,
  STEPS_MS,
  TICK_COLUMNS,
  adminChecker,
  adminKey,
  aggregate,
  createAdminHandler,
  historyReader,
  splitCsv,
  stepFor,
} from './admin.ts'
import { Buckets } from './history.ts'
import { HOT_HEADER, PEERS_HEADER, REPORTS_HEADER } from './stats.ts'

// Made-up credentials: tests never see a real login.
const LOGIN = 'admin:secret-for-tests'
const DOMAIN = 'relay.example'
const KEY = adminKey(LOGIN, DOMAIN)
const basic = (login) => `Basic ${Buffer.from(login).toString('base64')}`
const DAY = 86_400_000
const MIN = 60_000
const D1 = Date.parse('2026-09-28T00:00:00.000Z')
const D2 = D1 + DAY
const NOW = D2 + 12 * 3600_000
const ID_A = '12D3KooWAAAAtestpeerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const ID_B = '12D3KooWBBBBtestpeerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
// A parsed answer, read only field by field in asserts.
type Json = { [k: string]: Json }

test('the column constants are the relay files headers', () => {
  assert.equal(PEERS_COLUMNS.join(','), PEERS_HEADER)
  assert.equal(REPORTS_COLUMNS.join(','), REPORTS_HEADER)
})

test('adminKey is scrypt with a salt from the domain and user, and the same for the same login', () => {
  assert.match(KEY, /^scrypt\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/)
  assert.equal(adminKey(LOGIN, DOMAIN), KEY)
  const salt = (k) => k.split('.')[1]
  assert.equal(salt(adminKey('admin:other', DOMAIN)), salt(KEY))
  assert.notEqual(adminKey('admin:other', DOMAIN), KEY)
  assert.notEqual(salt(adminKey(LOGIN, 'other.example')), salt(KEY))
  assert.notEqual(salt(adminKey('root:secret-for-tests', DOMAIN)), salt(KEY))
  assert.throws(() => adminKey('no-colon', DOMAIN), /user:password/)
  assert.throws(() => adminKey(':only-password', DOMAIN), /user:password/)
})

test('adminChecker accepts the login only, and refuses malformed headers and keys', async () => {
  assert.throws(() => adminChecker('plain-password'), /invalid admin key/)
  assert.throws(() => adminChecker('scrypt.short.hash'), /invalid admin key/)
  const check = adminChecker(KEY)
  assert.equal(await check(basic(LOGIN)), true)
  assert.equal(await check(basic('admin:wrong')), false)
  assert.equal(await check(basic('other:secret-for-tests')), false)
  assert.equal(await check(basic('no-colon')), false)
  assert.equal(await check(undefined), false)
  assert.equal(await check(''), false)
  assert.equal(await check(`Bearer ${Buffer.from(LOGIN).toString('base64')}`), false)
  assert.equal(await check('Basic !!!'), false)
  // The key carries its salt, so another domain's key checks the same login.
  assert.equal(await adminChecker(adminKey(LOGIN, 'other.example'))(basic(LOGIN)), true)
})

test('adminChecker remembers a verified header and refuses past the waiting limit', async () => {
  const check = adminChecker(KEY)
  assert.equal(await check(basic(LOGIN)), true)
  // Twenty wrong logins queue at once: past the limit they are refused, while the remembered
  // header passes without waiting behind them.
  const wrong = Array.from({ length: 20 }, (_, i) => check(basic(`admin:wrong-${i}`)))
  const settled = Array(20).fill(false)
  wrong.forEach((p, i) => p.then(() => (settled[i] = true)))
  assert.equal(await check(basic(LOGIN)), true)
  assert.deepEqual(settled.slice(0, 16), Array(16).fill(false), 'a remembered header waits for no scrypt')
  assert.deepEqual(await Promise.all(wrong), Array(20).fill(false))
  await Promise.resolve()
  assert.deepEqual(settled, Array(20).fill(true))
})

/** Starts `handler` on a free port; returns its base URL and a close. */
async function serve(handler) {
  const server = createServer(handler)
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) }
}

test('the admin API answers 401 without the login and serves live and history with it', async (t) => {
  let snapshot: unknown = { time: 1, connections: { open: 3 } }
  const buckets = new Buckets()
  buckets.add(NOW - 3600_000, 5e9, 2)
  const { url, close } = await serve(
    createAdminHandler({ key: KEY, live: () => snapshot, history: () => buckets, now: () => NOW }),
  )
  t.after(close)
  const auth = { authorization: basic(LOGIN) }

  let r = await fetch(`${url}/admin/api/live`)
  assert.equal(r.status, 401)
  assert.match(r.headers.get('www-authenticate') ?? '', /^Basic realm="RebeLLM admin"/)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  r = await fetch(`${url}/admin/api/live`, { headers: { authorization: basic('admin:wrong') } })
  assert.equal(r.status, 401)
  r = await fetch(`${url}/admin/api/history?days=0`)
  assert.equal(r.status, 401, 'the login is checked before the query')

  r = await fetch(`${url}/admin/api/live`, { headers: auth })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(await r.json(), snapshot)
  snapshot = undefined
  r = await fetch(`${url}/admin/api/live`, { headers: auth })
  assert.equal(r.status, 503)

  r = await fetch(`${url}/admin/api/history?days=7`, { headers: auth })
  assert.equal(r.status, 200)
  const body = (await r.json()) as Json
  assert.equal(body.statistics, false)
  assert.equal(body.days, 7)
  assert.equal(body.from, NOW - 7 * DAY)
  assert.deepEqual(body.memory, buckets.toJson(7, NOW))

  for (const days of ['0', '-1', '1.5', 'x', String(MAX_DAYS + 1)]) {
    r = await fetch(`${url}/admin/api/history?days=${days}`, { headers: auth })
    assert.equal(r.status, 400, days)
  }
  r = await fetch(`${url}/admin/api/nothing`, { headers: auth })
  assert.equal(r.status, 404)
  r = await fetch(`${url}/admin/api/live`, { method: 'POST', headers: auth })
  assert.equal(r.status, 405)
  r = await fetch(`${url}/stats/history`, { headers: auth })
  assert.equal(r.status, 404, 'without next, other paths are 404')
  r = await fetch(`${url}/admin/api/live`, { method: 'HEAD', headers: auth })
  assert.equal(r.status, 503)
})

test('the admin handler passes other paths on, needs a key and is open only with null', async (t) => {
  assert.throws(() => createAdminHandler({ key: undefined, live: () => ({}) }), /needs a key/)
  assert.throws(() => createAdminHandler({ key: 'nope', live: () => ({}) }), /invalid admin key/)
  const open = createAdminHandler({ key: null, live: () => ({ ok: true }) })
  let passed = 0
  const { url, close } = await serve((req, res) =>
    open(req, res, () => {
      passed++
      res.end('next')
    }),
  )
  t.after(close)
  assert.equal(await (await fetch(`${url}/stats/history`)).text(), 'next')
  assert.equal(await (await fetch(`${url}/admin/`)).text(), 'next')
  assert.equal(passed, 2)
  const r = await fetch(`${url}/admin/api/live`)
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { ok: true })
})

test('splitCsv keeps quoted commas and doubled quotes', () => {
  assert.deepEqual(splitCsv('a,"b,c",,"say ""hi""",5'), ['a', 'b,c', '', 'say "hi"', '5'])
  assert.deepEqual(splitCsv(''), [''])
  assert.deepEqual(splitCsv('"x"'), ['x'])
  assert.deepEqual(splitCsv('1,'), ['1', ''])
})

test('stepFor keeps a span within 400 points', () => {
  assert.equal(stepFor(DAY), 5 * MIN)
  assert.equal(stepFor(7 * DAY), 30 * MIN)
  assert.equal(stepFor(30 * DAY), 120 * MIN)
  assert.equal(stepFor(365 * DAY), DAY)
  assert.equal(stepFor(MAX_DAYS * DAY), STEPS_MS[STEPS_MS.length - 1])
})

test('aggregate sums the counts, keeps the gauges peak and averages the rest', () => {
  const T = Object.fromEntries(TICK_COLUMNS.map((c, i) => [c, i]))
  const row = (t, v) => {
    const r = new Float64Array(TICK_COLUMNS.length).fill(NaN)
    r[0] = t
    for (const [k, x] of Object.entries(v as Record<string, number>)) r[T[k]] = x
    return r
  }
  const rows = aggregate(
    [
      row(D1, { peers: 2, relayedBytes: 100, rssBytes: 50, loopLagMs: 3 }),
      row(D1 + 5 * MIN, { peers: 3, relayedBytes: 50, rssBytes: 70, loopLagMs: 1 }),
      row(D1 + 15 * MIN, { peers: 4 }),
    ],
    15 * MIN,
  )
  assert.equal(rows.length, 2)
  const [a, b] = rows
  assert.equal(a[T.t], D1)
  assert.equal(a[T.peers], 2.5)
  assert.equal(a[T.relayedBytes], 150)
  assert.equal(a[T.rssBytes], 70)
  assert.equal(a[T.loopLagMs], 3)
  assert.equal(a[T.connections], null)
  assert.equal(b[T.t], D1 + 15 * MIN)
  assert.equal(b[T.peers], 4)
  assert.equal(b[T.relayedBytes], null)
  assert.deepEqual(aggregate([], 5 * MIN), [])
})

/** A CSV line from named cells in `columns`' order. */
function line(columns, cells) {
  return columns.map((c) => cells[c] ?? '').join(',')
}
const iso = (t) => new Date(t).toISOString()
const q = (s) => `"${s}"`
// The headers from before the files lost the peer ids.
const OLD_PEERS_COLUMNS = ['time', 'peer', ...PEERS_COLUMNS.slice(2, -1)]
const OLD_REPORTS_COLUMNS = ['time', 'peer', ...REPORTS_COLUMNS.slice(1)]

/** A per-node row as old files held it. */
function peerRow(t, id, { gpu = 'nvidia', app = 'ide', precision = 'f16' } = {}) {
  return line(OLD_PEERS_COLUMNS, {
    time: iso(t),
    peer: q(id),
    transport: q('ws'),
    model: q('m'),
    gpu: q(gpu),
    precision: q(precision),
    vram_bytes: 8e9,
    budget_bytes: 4e9,
    loaded: 10,
    served: 5,
    calls_per_sec: 0.5,
    app: q(app),
    relayed_bytes: 100,
  })
}
function totalRow(t, peers, budget, columns = PEERS_COLUMNS) {
  return line(columns, {
    time: iso(t),
    row: 'total',
    peer: 'total',
    calls_per_sec_sum: peers * 1.5,
    vram_bytes: 8e9,
    budget_bytes: budget,
    loaded: 10,
    served: 5,
    calls_per_sec: peers,
    ram_bytes: 1e9,
    relayed_bytes: 100,
  })
}
function networkRow(
  t,
  { connections = 4, relayed = 1000, rss = 9e7, streams = 2, tokens = 1 } = {},
  columns = PEERS_COLUMNS,
) {
  return line(columns, {
    time: iso(t),
    row: 'network',
    peer: 'network',
    transport: connections,
    model: connections,
    gpu: 0,
    precision: 30,
    vram_bytes: 1,
    budget_bytes: 2,
    loaded: 3,
    served: 0,
    calls_per_sec: relayed,
    loop_lag_ms: 2,
    rss_bytes: rss,
    heap_bytes: 4e7,
    reservations: 1,
    subscribers: 2,
    opened: 3,
    streams,
    refused: 0,
    tokens,
  })
}
function reportRow(
  t,
  id,
  { decode = 10, tokens = 100, browser = 'chrome', phone = 0, up = 0 } = {},
  columns = REPORTS_COLUMNS,
) {
  return line(columns, {
    time: iso(t),
    peer: q(id),
    app: q('chat'),
    gpu: q('apple, m2'),
    precision: q('f16'),
    phone,
    browser,
    os: 'mac',
    requests: 1,
    tokens,
    decode_tok_per_sec: decode,
    prefill_tok_per_sec: 0,
    net_up_per_token: up,
  })
}

/** A counts file row; an empty value is unknown. */
const countRow = (t, set, field, value, n) => `${iso(t)},${set},${field},${value === '' ? '' : q(value)},${n}`

/**
 * Two days of files: the 28th from before the peer ids went, with a peer row, two late ticks
 * and the counts the migration wrote; the 29th in the current layout, a row without the newer
 * columns, and a restart in its counts.
 */
async function seed(dir) {
  const d1 = [OLD_PEERS_COLUMNS.join(','), peerRow(D1 + 23 * 3600_000, ID_A, { gpu: 'old gpu' })]
  for (const m of [50, 55]) {
    const t = D1 + 23 * 3600_000 + m * MIN
    d1.push(totalRow(t, 1, 4e9, OLD_PEERS_COLUMNS), networkRow(t, {}, OLD_PEERS_COLUMNS))
  }
  const oldRow = `${iso(D2)},network,2,2,0,10,1,1,1,0,500,,,,1`
  const d2 = [PEERS_HEADER, oldRow, totalRow(D2, 2, 6e9)]
  for (const t of [D2 + 5 * MIN, D2 + 11 * 3600_000]) d2.push(totalRow(t, 2, 8e9), networkRow(t))
  // A tick after now is not in the range.
  d2.push(networkRow(NOW + 3600_000, { relayed: 999_999 }))
  await writeFile(join(dir, 'peers-2026-09-28.csv'), d1.join('\n') + '\n')
  await writeFile(join(dir, 'peers-2026-09-29.csv'), d2.join('\n') + '\n')
  const late = D1 + 23 * 3600_000
  await writeFile(
    join(dir, 'reports-2026-09-28.csv'),
    [OLD_REPORTS_COLUMNS.join(','), reportRow(late, ID_A, { decode: 0, tokens: 11 }, OLD_REPORTS_COLUMNS)].join('\n') +
      '\n',
  )
  await writeFile(
    join(dir, 'counts-2026-09-28.csv'),
    [
      'time,set,field,value,count',
      countRow(late, 'nodes', 'all', '', 1),
      countRow(late, 'nodes', 'gpu', 'old gpu', 1),
      countRow(late, 'nodes', 'app', 'ide', 1),
      countRow(late, 'nodes', 'transport', 'ws', 1),
      countRow(late, 'reporters', 'all', '', 1),
      countRow(late, 'reporters', 'browser', 'chrome', 1),
      countRow(late, 'reporters', 'phone', 'desktop', 1),
    ].join('\n') + '\n',
  )
  const nodes = (t, n, gpus) => [
    countRow(t, 'live', 'all', '', 9),
    countRow(t, 'nodes', 'all', '', n),
    ...gpus.map(([g, k]) => countRow(t, 'nodes', 'gpu', g, k)),
    countRow(t, 'nodes', 'transport', 'ws', n),
  ]
  const t1 = D2 + 5 * MIN
  await writeFile(
    join(dir, 'counts-2026-09-29.csv'),
    [
      'time,set,field,value,count',
      ...nodes(t1, 2, [['nvidia', 2]]),
      countRow(t1, 'reporters', 'all', '', 2),
      countRow(t1, 'reporters', 'browser', 'chrome', 1),
      countRow(t1, 'reporters', 'browser', 'firefox', 1),
      countRow(t1, 'reporters', 'phone', 'desktop', 1),
      countRow(t1, 'reporters', 'phone', 'phone', 1),
      countRow(t1, 'reporters', 'gpu', 'apple, m2', 2),
      // As many nodes later: the latest of equal ticks counts.
      ...nodes(D2 + 10 * MIN, 2, [
        ['Apple, M2', 1],
        ['nvidia', 1],
      ]),
      countRow(D2 + 10 * MIN, 'nodes', 'app', 'chat', 1),
      countRow(D2 + 10 * MIN, 'nodes', 'app', 'ide', 1),
      // A restart began the count again: fewer, so not the day's.
      ...nodes(D2 + 11 * 3600_000, 1, [['', 1]]),
      countRow(D2 + 11 * 3600_000, 'reporters', 'all', '', 0),
    ].join('\n') + '\n',
  )
  await writeFile(
    join(dir, 'reports-2026-09-29.csv'),
    [
      REPORTS_HEADER,
      reportRow(D2 + MIN, ID_A, { decode: 10, tokens: 100, up: 169_984 }),
      reportRow(D2 + 2 * MIN, ID_A, { decode: 30, tokens: 50, browser: 'firefox' }),
      reportRow(D2 + 3 * MIN, ID_B, { decode: 0, tokens: 7, phone: 1 }),
    ].join('\n') + '\n',
  )
  await writeFile(
    join(dir, 'hot-2026-09-29.csv'),
    [HOT_HEADER, `${iso(D2)},0,3,5`, `${iso(D2)},1,2,10`, `${iso(D2 + MIN)},0,3,5`, 'junk'].join('\n') + '\n',
  )
  await writeFile(join(dir, 'peers.csv'), 'not a daily file\n')
}

test('the history reads the daily files into ticks, days, shares, reports, hot experts and files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rebellm-admin-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await seed(dir)
  const reader = historyReader(dir, { random: () => 0 })
  const T = Object.fromEntries(TICK_COLUMNS.map((c, i) => [c, i]))

  const all = await reader.read(undefined, NOW)
  assert.equal(all.statistics, true)
  assert.equal(all.days, null)
  assert.equal(all.from, null)
  assert.equal(all.memory, null)
  assert.equal(all.daysFrom, D1)
  assert.equal(all.ticks.step, 5 * MIN)
  assert.deepEqual(all.ticks.columns, TICK_COLUMNS)
  assert.deepEqual(
    all.ticks.rows.map((r) => r[0]),
    [D1 + 23 * 3600_000 + 50 * MIN, D1 + 23 * 3600_000 + 55 * MIN, D2, D2 + 5 * MIN, D2 + 11 * 3600_000],
  )
  const [first, , old, fifth] = all.ticks.rows
  assert.equal(first[T.peers], 1)
  // Old files have no summed calls per second; current ones do.
  assert.equal(first[T.callsPerSec], null)
  assert.equal(fifth[T.callsPerSec], 3)
  assert.equal(first[T.memoryBytes], 5e9)
  assert.equal(first[T.connections], 4)
  assert.equal(first[T.relayedBytes], 1000)
  assert.equal(first[T.rssBytes], 9e7)
  assert.equal(first[T.streams], 2)
  // A row from before the newer columns leaves them empty.
  assert.equal(old[T.relayedBytes], 500)
  assert.equal(old[T.loopLagMs], 1)
  assert.equal(old[T.rssBytes], null)
  assert.equal(old[T.tokens], null)
  assert.equal(old[T.peers], 2)
  assert.equal(fifth[T.memoryBytes], 9e9)

  assert.deepEqual(
    all.daily.map((d) => [d.day, d.ticks, d.peers, d.peakPeers, d.relayedBytes, d.streams, d.modelTokens, d.reports]),
    [
      ['2026-09-28', 2, 1, 1, 2000, 4, 2, 1],
      // The tick after now is in its day's table but not in the range's ticks.
      ['2026-09-29', 4, 2, 2, 500 + 1000 + 1000 + 999_999, 6, 3, 3],
    ],
  )
  assert.deepEqual(
    all.daily.map((d) => d.reporters),
    [1, 2],
  )
  assert.equal(all.daily[1].tokensGenerated, 157)

  // Peer-days: the 28th's one and the 29th's two.
  assert.equal(all.peers.count, 3)
  assert.deepEqual(all.peers.shares.gpu, [
    { key: 'Apple, M2', count: 1 },
    { key: 'nvidia', count: 1 },
    { key: 'old gpu', count: 1 },
  ])
  assert.deepEqual(all.peers.shares.app, [
    { key: 'ide', count: 2 },
    { key: 'chat', count: 1 },
  ])
  assert.deepEqual(all.peers.shares.transport, [{ key: 'ws', count: 3 }])
  assert.deepEqual(all.peers.shares.model, [])

  // The 28th's row is read through its header with the peer column.
  assert.equal(all.reports.rows, 4)
  assert.equal(all.reports.reporters, 3)
  assert.equal(all.reports.sums.tokens, 168)
  assert.equal(all.reports.sums.requests, 4)
  // Zero means nothing measured: the median is over 10 and 30 (lower median), not the 0.
  assert.equal(all.reports.medians.decodeTokPerSec, 10)
  assert.equal(all.reports.medians.prefillTokPerSec, null)
  // bytes per token, from rows that have the late columns
  assert.equal(all.reports.medians.netUpPerToken, 169_984)
  assert.equal(all.reports.medians.netDownPerToken, null)
  assert.deepEqual(all.reports.shares.browser, [
    { key: 'chrome', count: 2 },
    { key: 'firefox', count: 1 },
  ])
  assert.deepEqual(all.reports.shares.phone, [
    { key: 'desktop', count: 2 },
    { key: 'phone', count: 1 },
  ])
  assert.deepEqual(all.reports.shares.gpu, [{ key: 'apple, m2', count: 2 }])

  assert.equal(all.hot.total, 20)
  assert.deepEqual(all.hot.top, [
    { layer: 0, expert: 3, demand: 10, share: 0.5 },
    { layer: 1, expert: 2, demand: 10, share: 0.5 },
  ])

  assert.equal(all.files.count, 7)
  assert.equal(all.files.first, '2026-09-28')
  assert.equal(all.files.last, '2026-09-29')
  const { bytes } = all.files
  assert.ok(bytes.peers > 0 && bytes.reports > 0 && bytes.hot > 0 && bytes.counts > 0)

  const text = JSON.stringify(all)
  assert.ok(!text.includes('12D3Koo'), 'no peer id leaves')

  // One day: its own counts, exact.
  const today = await reader.read(1, D2 + DAY)
  assert.deepEqual(
    today.daily.map((d) => d.day),
    ['2026-09-29'],
  )
  assert.equal(today.peers.count, 2)

  // One day back reaches into the 28th: its ticks after noon, and the whole day in the tables.
  const day = await reader.read(1, NOW, new Buckets())
  assert.equal(day.days, 1)
  assert.equal(day.from, NOW - DAY)
  assert.deepEqual(day.memory, { intervalHours: 6, points: [] })
  assert.equal(day.ticks.step, 5 * MIN)
  assert.equal(day.ticks.rows.length, 5)
  assert.equal(day.daily.length, 2)
  // Ending on the 28th: the 29th is out, even its tick at midnight.
  const before = await reader.read(1, D2 - 1)
  assert.deepEqual(
    before.daily.map((d) => d.day),
    ['2026-09-28'],
  )
  assert.equal(before.ticks.rows.length, 2)
  const week = await reader.read(7, NOW)
  assert.equal(week.ticks.step, 30 * MIN)
  assert.equal(week.ticks.rows.length, 3)
  const late = week.ticks.rows[0]
  assert.equal(late[T.relayedBytes], 2000, 'the two late ticks of the 28th share a step')
})

test('the history reader rereads only a day whose files changed, and forgets deleted days', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rebellm-admin-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await seed(dir)
  const reader = historyReader(dir)
  await reader.read(undefined, NOW)
  const before = new Map([...reader.cache].map(([k, v]) => [k, v.day]))
  assert.deepEqual([...before.keys()], [D1, D2])
  await reader.read(undefined, NOW)
  for (const [k, v] of reader.cache) assert.equal(v.day, before.get(k), 'unchanged days are not reread')

  await appendFile(join(dir, 'peers-2026-09-29.csv'), totalRow(D2 + 11.5 * 3600_000, 3, 1e9) + '\n')
  const after = await reader.read(undefined, NOW)
  assert.equal(reader.cache.get(D1)?.day, before.get(D1))
  assert.notEqual(reader.cache.get(D2)?.day, before.get(D2))
  assert.equal(after.daily[1].ticks, 5)

  for (const kind of ['peers', 'reports', 'counts']) await rm(join(dir, `${kind}-2026-09-28.csv`))
  const gone = await reader.read(undefined, NOW)
  assert.deepEqual([...reader.cache.keys()], [D2])
  assert.equal(gone.daily.length, 1)
  assert.equal(gone.files.first, '2026-09-29')
})

test('the admin API serves the history of a statistics directory', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rebellm-admin-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await seed(dir)
  const { url, close } = await serve(createAdminHandler({ key: KEY, live: () => ({}), dir, now: () => NOW }))
  t.after(close)
  const r = await fetch(`${url}/admin/api/history?days=30`, { headers: { authorization: basic(LOGIN) } })
  assert.equal(r.status, 200)
  const body = (await r.json()) as Json
  assert.equal(body.statistics, true)
  assert.equal(body.ticks.step, 120 * MIN)
  assert.equal(body.daily.length, 2)
})
