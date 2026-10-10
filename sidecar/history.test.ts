import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  BUCKET_MS,
  Buckets,
  MAX_VALUES,
  createHistoryHandler,
  fromCsv,
  loadCsv,
  loadHistory,
  writeHistory,
} from './history.ts'
import { PEERS_HEADER, RelayStats, STATS_INTERVAL_MS } from './stats.ts'

const GB = 2 ** 30
const DAY = 86_400_000
// Midnight UTC starts a bucket.
const T0 = Date.parse('2026-09-20T00:00:00.000Z')
const ID = '12D3KooWQSPFiaqTCTY9whhkWQpHQSbhawEuG9zCki6bLermCBJH'

/** The JSON body of a response, cast. @param {Response} r */
async function json<T>(r: Response): Promise<T> {
  return (await r.json()) as T
}

/**
 * peers.csv over `days` days of five-minute ticks: in bucket i the budgets are (10 + i) GB plus
 * j kB for tick j, peers 1, 2, 3 in turn; each tick also has a peer and a network row.
 */
function peersCsv(days) {
  const lines = [PEERS_HEADER]
  for (let k = 0; k < (days * DAY) / STATS_INTERVAL_MS; k++) {
    const t = new Date(T0 + k * STATS_INTERVAL_MS).toISOString()
    const i = Math.floor(k / MAX_VALUES)
    const j = k % MAX_VALUES
    // A peer's string with ",total," inside its quotes must not count as a total row.
    lines.push(`${t},"${ID}","ws","m","x,total,1",,${GB},${GB},1,1,0.5,"app"`)
    lines.push(`${t},total,,,,,${2 * GB},${(10 + i) * GB + j * 1000},3,4,${(j % 3) + 1},`)
    lines.push(`${t},network,1,1,0,420,1,1,1,0,0,`)
  }
  return `${lines.join('\n')}\n`
}

/** Writes peersCsv's rows as the relay's daily peers files in `dir`, each with its header. */
async function writeDaily(dir, text) {
  const days = new Map()
  for (const line of text.split('\n').slice(1).filter(Boolean)) {
    const day = line.slice(0, 10)
    days.set(day, [...(days.get(day) ?? [PEERS_HEADER]), line])
  }
  for (const [day, lines] of days) await writeFile(join(dir, `peers-${day}.csv`), `${lines.join('\n')}\n`)
  return [...days.keys()]
}

/** The expected point of bucket i of peersCsv. */
const pointOf = (i) => ({
  t: T0 + i * BUCKET_MS,
  median: (10 + i) * GB + 35_000,
  min: (10 + i) * GB,
  max: (10 + i) * GB + 71_000,
  peers: 2,
})

test('buckets: 6-hour keys, lower medians, min, max and the median peer count; closed ones as summaries', () => {
  const b = new Buckets()
  for (const [dt, bytes, peers] of [
    [0, 4, 1],
    [5, 1, 3],
    [10, 3, 2],
    [15, 2, 2],
  ])
    assert.ok(b.add(T0 + dt * 60_000, bytes, peers))
  // Next bucket: the first closes into a summary without its values.
  assert.ok(b.add(T0 + BUCKET_MS, 7, 5))
  assert.deepEqual(b.closed, [{ t: T0, n: 4, median: 2, min: 1, max: 4, peers: 2 }])
  assert.equal(b.open?.values.length, 1)
  assert.deepEqual(b.toJson(), {
    intervalHours: 6,
    points: [
      { t: T0, median: 2, min: 1, max: 4, peers: 2 },
      { t: T0 + BUCKET_MS, median: 7, min: 7, max: 7, peers: 5 },
    ],
  })
  // A time before the open bucket or a non-number is not taken.
  assert.equal(b.add(T0, 9, 1), false)
  assert.equal(b.add(Number.NaN, 9, 1), false)
  assert.equal(b.add(T0 + BUCKET_MS, Number.NaN, 1), false)
  // A gap leaves no empty buckets between.
  b.add(T0 + 4 * BUCKET_MS + 1, 8, 1)
  assert.deepEqual(
    b.toJson().points.map((p) => p.t),
    [T0, T0 + BUCKET_MS, T0 + 4 * BUCKET_MS],
  )
})

test('buckets: at most 72 values for the medians, min and max from every tick', () => {
  const b = new Buckets()
  for (let j = 0; j < MAX_VALUES + 8; j++)
    b.add(T0 + j * 1000, j < MAX_VALUES ? 100 + j : j === MAX_VALUES ? 1 : 900, 1)
  assert.equal(b.open?.values.length, MAX_VALUES)
  assert.equal(b.open?.n, MAX_VALUES + 8)
  assert.deepEqual(b.toJson().points[0], { t: T0, median: 135, min: 1, max: 900, peers: 1 })
})

test('rebuilt from peers.csv: two days give eight buckets with their medians and no peer id', () => {
  const text = peersCsv(2)
  const json = fromCsv(text).toJson()
  assert.equal(json.intervalHours, 6)
  assert.deepEqual(
    json.points,
    Array.from({ length: 8 }, (_, i) => pointOf(i)),
  )
  assert.doesNotMatch(JSON.stringify(json), /12D3|"app"|ws/)
  // Windows line ends and a file without rows read the same.
  assert.deepEqual(fromCsv(text.replaceAll('\n', '\r\n')).toJson(), json)
  assert.deepEqual(fromCsv(`${PEERS_HEADER}\n`).toJson(), { intervalHours: 6, points: [] })
})

test('the whole history is kept; ?days gives the buckets that end within the last N days', () => {
  const b = fromCsv(peersCsv(3))
  assert.equal(b.toJson().points.length, 12)
  const now = T0 + 3 * DAY
  assert.deepEqual(
    b.toJson(1, now).points.map((p) => p.t),
    [0, 1, 2, 3].map((i) => T0 + 2 * DAY + i * BUCKET_MS),
  )
  // A bucket that ends after the cut-off counts, even when it began before it.
  assert.equal(b.toJson(1, now + BUCKET_MS / 2).points[0].t, T0 + 2 * DAY)
  assert.equal(b.toJson(30, now).points.length, 12)
})

test("a tick's total row reads back, and every tick feeds the history", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-history-'))
  try {
    let now = T0 + 5 * 60_000
    const history = new Buckets()
    const stats = new RelayStats({ file: join(dir, 'peers.csv'), now: () => now, history })
    const announce = {
      v: 1,
      model: 'm',
      layers: 1,
      experts: 8,
      served: btoa(String.fromCharCode(3)),
      budgetBytes: 6 * GB,
      loaded: 2,
    }
    const enc = (o) => new TextEncoder().encode(JSON.stringify(o))
    assert.ok(stats.record('a', 'ws', enc(announce)))
    // RAM tiers count as expert memory, in the CSV row and in the tick alike.
    assert.ok(stats.record('b', 'ws', enc({ ...announce, budgetBytes: 26 * GB, ramBytes: 4 * GB })))
    const rows = stats.lines([]).peers.join('\n')
    assert.deepEqual(fromCsv(rows).toJson().points, [{ t: T0, median: 36 * GB, min: 36 * GB, max: 36 * GB, peers: 2 }])
    await stats.tick([])
    now += STATS_INTERVAL_MS
    stats.forget('b')
    await stats.tick([])
    assert.deepEqual(history.toJson().points, [{ t: T0, median: 6 * GB, min: 6 * GB, max: 36 * GB, peers: 1 }])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('read from the file line by line; no file is an empty history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-history-'))
  try {
    const file = join(dir, 'peers.csv')
    assert.deepEqual((await loadCsv(file)).toJson(), { intervalHours: 6, points: [] })
    const text = peersCsv(1)
    await writeFile(file, text)
    assert.deepEqual((await loadCsv(file)).toJson(), fromCsv(text).toJson())
    await assert.rejects(loadCsv(dir))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/** Serves `handler` on loopback; returns a request helper and a closer. */
async function serve(handler) {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server not listening')
  const base = `http://127.0.0.1:${addr.port}`
  return {
    get: (path, init?) => fetch(`${base}${path}`, init),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('GET /stats/history: JSON with a five-minute cache, ?days=N, 404 for other /stats/ paths', async () => {
  const b = fromCsv(peersCsv(2))
  const s = await serve(createHistoryHandler(b, { now: () => T0 + 2 * DAY }))
  try {
    const r = await s.get('/stats/history')
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('content-type'), 'application/json')
    assert.equal(r.headers.get('cache-control'), 'public, max-age=300')
    assert.deepEqual(await r.json(), b.toJson())
    const day = await json<{ points: { t: number; median: number; min: number; max: number; peers: number }[] }>(
      await s.get('/stats/history?days=1'),
    )
    assert.deepEqual(day.points, [4, 5, 6, 7].map(pointOf))
    for (const bad of ['0', '-1', '1.5', 'x', '36501']) {
      const r = await s.get(`/stats/history?days=${bad}`)
      assert.equal(r.status, 400, bad)
      assert.equal(r.headers.get('cache-control'), 'no-store')
    }
    for (const path of ['/stats/anything-else', '/stats/', '/stats/history/x', '/']) {
      const r = await s.get(path)
      assert.equal(r.status, 404, path)
      assert.deepEqual(await r.json(), { error: 'not found' })
    }
    assert.equal((await s.get('/stats/history', { method: 'POST' })).status, 405)
    const head = await s.get('/stats/history', { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(await head.text(), '')
  } finally {
    await s.close()
  }
})

test('as a middleware: other paths go on, and the route too without statistics; 404 on its own server', async () => {
  let history
  const handler = createHistoryHandler(() => history)
  const s = await serve((req, res) =>
    handler(req, res, () => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('app')
    }),
  )
  try {
    assert.equal(await (await s.get('/index.html')).text(), 'app')
    assert.equal((await s.get('/stats/other')).status, 404)
    assert.equal(await (await s.get('/stats/history?days=30')).text(), 'app')
    const own = await serve(createHistoryHandler(() => undefined))
    try {
      const none = await own.get('/stats/history?days=30')
      assert.equal(none.status, 404)
      assert.deepEqual(await none.json(), { error: 'this relay keeps no statistics' })
    } finally {
      await own.close()
    }
    history = fromCsv(peersCsv(1))
    assert.equal((await json<{ points: unknown[] }>(await s.get('/stats/history'))).points.length, 4)
  } finally {
    await s.close()
  }
})

test('history.json, then the old peers.csv, then the daily files newer than it, each row once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-history-'))
  try {
    const all = peersCsv(3)
    const lines = all.split('\n')
    const day1 = lines.filter((l) => l.startsWith('2026-09-20'))
    // Saved a third of the way into day 2, mid-bucket.
    const json = join(dir, 'history.json')
    await writeHistory(json, fromCsv(lines.slice(0, 1 + day1.length + 300).join('\n')))
    const csv = join(dir, 'peers.csv')
    await writeFile(csv, `${[PEERS_HEADER, ...day1].join('\n')}\n`)
    await writeDaily(dir, [PEERS_HEADER, ...lines.slice(1 + day1.length)].join('\n'))
    // A day that ended before the saved history is not opened: a directory would throw if it were.
    await mkdir(join(dir, 'peers-2026-09-19.csv'))
    await writeFile(join(dir, 'hot-2026-09-22.csv'), 'not peers rows,total,\n')
    const merged = await loadHistory(json, csv)
    const whole = fromCsv(all)
    assert.deepEqual(merged.toJson(), whole.toJson())
    assert.equal(merged.upTo, whole.upTo)
    assert.equal(merged.open?.n, whole.open?.n)
    // Without history.json every day is read: the old file and the daily files alone, the same buckets.
    await rm(join(dir, 'peers-2026-09-19.csv'), { recursive: true })
    await rm(json)
    assert.deepEqual((await loadHistory(json, csv)).toJson(), whole.toJson())
    // Without the old file: the daily files alone.
    await rm(csv)
    assert.deepEqual(
      (await loadHistory(json, csv)).toJson(),
      fromCsv([PEERS_HEADER, ...lines.slice(1 + day1.length)].join('\n')).toJson(),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a total row counts its RAM tiers; a row from before the RAM column counts VRAM only', () => {
  const t = new Date(T0).toISOString()
  const withRam = `${t},total,,,,,${50 * GB},${40 * GB},0,0,2,,${80 * GB},0`
  const old = `${t},total,,,,,${50 * GB},${40 * GB},0,0,2,`
  // A row with loop_lag_ms, the latest column, reads the same.
  const withLag = `${withRam},`
  assert.equal(fromCsv(`${PEERS_HEADER}\n${withRam}\n`).toJson().points[0].median, 120 * GB)
  assert.equal(fromCsv(`${PEERS_HEADER}\n${withLag}\n`).toJson().points[0].median, 120 * GB)
  assert.equal(fromCsv(`${PEERS_HEADER}\n${old}\n`).toJson().points[0].median, 40 * GB)
})

test('history.json: a save and restore round trip, then only the CSV rows newer than it are read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-history-'))
  try {
    const all = peersCsv(3)
    const lines = all.split('\n')
    // the first half is saved; the second half arrives in the CSV after that, mid-bucket
    const first = fromCsv(`${lines.slice(0, 401).join('\n')}\n`)
    const json = join(dir, 'history.json')
    const csv = join(dir, 'peers.csv')
    await writeHistory(json, first)
    const restored = Buckets.restore(JSON.parse(await readFile(json, 'utf8')))
    assert.deepEqual(restored.toJson(), first.toJson())
    assert.equal(restored.upTo, first.upTo)
    await writeFile(csv, all)
    const merged = await loadHistory(json, csv)
    const whole = fromCsv(all)
    assert.deepEqual(merged.toJson(), whole.toJson())
    assert.equal(merged.upTo, whole.upTo)
    assert.equal(merged.open?.n, whole.open?.n)
    // a CSV pruned to rows the file already holds loses nothing, and counts none twice
    await writeFile(csv, `${PEERS_HEADER}\n${lines.slice(300).join('\n')}\n`)
    assert.deepEqual((await loadHistory(json, csv)).toJson(), whole.toJson())
    // no file: the CSV alone; an unreadable file: reported, then the CSV alone
    assert.deepEqual(
      (await loadHistory(join(dir, 'none.json'), csv)).toJson(),
      fromCsv(await readFile(csv, 'utf8')).toJson(),
    )
    await writeFile(json, '{"v":2}')
    const warnings: string[] = []
    const fallback = await loadHistory(json, csv, { warn: (m) => warnings.push(m) })
    assert.deepEqual(fallback.toJson(), fromCsv(await readFile(csv, 'utf8')).toJson())
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /not a history file/)
    for (const bad of [
      null,
      [],
      { v: 1 },
      { v: 1, closed: [{ t: 1 }], open: null, upTo: null },
      { v: 1, closed: [], open: { key: 1 }, upTo: 5 },
    ])
      assert.throws(() => Buckets.restore(bad))
    assert.deepEqual(new Buckets().save(), { v: 1, upTo: null, closed: [], open: null })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
