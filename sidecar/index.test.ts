import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { adminKey } from './admin.ts'
import { PEERS_HEADER, REPORTS_HEADER, newCounters } from './stats.ts'

// Made-up credentials: tests never see a real login.
const LOGIN = 'admin:secret-for-tests'
const KEY = adminKey(LOGIN, 'relay.example')
const auth = { authorization: `Basic ${Buffer.from(LOGIN).toString('base64')}` }
const PEER = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo'
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')

async function freePort() {
  const s = createServer()
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()))
  const { port } = s.address() as { port: number }
  await new Promise((resolve) => s.close(resolve))
  return port
}

/** The sidecar as the relay starts it, with this test in the relay's place. */
function sidecar(snapshot: () => unknown = () => undefined) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('index.ts', import.meta.url))], {
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const lines: { t?: string; id?: number; line?: string }[] = []
  const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`)
  createInterface({ input: child.stdout }).on('line', (l) => {
    const m = JSON.parse(l)
    lines.push(m)
    // The relay answers every question with its snapshot.
    if (m.t === 'get') send({ t: 'res', id: m.id, snapshot: snapshot() ?? null })
  })
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
  const logged = (text) => lines.some((l) => (l.t === 'log' || l.t === 'err') && l.line?.includes(text))
  const until = async (ok: () => boolean | Promise<boolean>, what: string, ms = 20_000) => {
    for (const end = Date.now() + ms; !(await ok());) {
      if (Date.now() > end) assert.fail(`timed out waiting for ${what}; lines:\n${JSON.stringify(lines, null, 1)}`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  return { child, lines, send, exited, logged, until }
}

test('the sidecar serves the admin API from the relay snapshots and ends when its input closes', async (t) => {
  const port = await freePort()
  const live = { time: 1, statistics: false, connections: { open: 0 }, counters: newCounters(), peers: null }
  let answer: unknown = live
  const s = sidecar(() => answer)
  t.after(() => s.child.kill())
  s.send({
    t: 'hello',
    v: 1,
    peerId: 'RELAY',
    connections: [],
    options: { statsPort: port, host: '127.0.0.1', adminKey: KEY },
  })
  await s.until(() => s.logged(`admin API on 127.0.0.1:${port}/admin/api/`), 'the admin line')
  assert.ok(!s.logged('VRAM history on'), 'without statistics there is no history to serve')
  const url = `http://127.0.0.1:${port}`
  assert.equal((await fetch(`${url}/admin/api/live`)).status, 401)
  let r = await fetch(`${url}/admin/api/live`, { headers: auth })
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), live)
  const h = (await (await fetch(`${url}/admin/api/history`, { headers: auth })).json()) as { statistics: boolean }
  assert.equal(h.statistics, false)
  // Without --stats there is no history to pass on to.
  assert.equal((await fetch(`${url}/stats/history`)).status, 404)
  // A relay with no snapshot to give: the live answer is not available.
  answer = undefined
  r = await fetch(`${url}/admin/api/live`, { headers: auth })
  assert.equal(r.status, 503)
  s.child.stdin.end()
  assert.equal(await s.exited, 0)
})

test('the sidecar writes the statistics of the relay it is told about, tick by tick, and no peer id', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sidecar-stats-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const port = await freePort()
  const counters = { ...newCounters(), connectionsOpened: 1, relayedStreams: 1, relayedBytes: 150 }
  const s = sidecar(() => ({
    statistics: true,
    counters,
    reservations: 1,
    gossip: { announce: { subscribers: 1 } },
    process: { rssBytes: 90e6, heapUsedBytes: 40e6, loopLagMs: 7 },
    peers: null,
  }))
  t.after(() => s.child.kill())
  const addr = '/ip4/172.19.0.5/tcp/1/ws'
  s.send({
    t: 'hello',
    v: 1,
    peerId: 'RELAY',
    connections: [{ id: '1', peer: PEER, addr, open: Date.now() }],
    options: { stats: join(dir, 'peers.csv'), statsPort: port, host: '127.0.0.1', adminKey: KEY, intervalMs: 300 },
  })
  await s.until(() => s.logged(`VRAM history on 127.0.0.1:${port}/stats/history`), 'the history line')
  const served = Buffer.from([0b101]).toString('base64')
  const announce = { v: 1, model: 'm', layers: 1, experts: 8, served, vramBytes: 8e9, app: 'x' }
  // Announces go on as a browser sends them; one is enough per window, more do no harm.
  const announcing = setInterval(() => s.send({ t: 'announce', peer: PEER, data: b64(announce) }), 50)
  t.after(() => clearInterval(announcing))
  s.send({ t: 'report', peer: PEER, data: b64({ v: 1, app: 'x', trunk: { tokens: 5 } }) })
  s.send({ t: 'relayed', peers: [PEER, 'peerOther'], bytes: 150 })
  const files = async (kind) => (await readdir(dir)).filter((f) => f.startsWith(`${kind}-`)).map((f) => join(dir, f))
  const text = async (kind) => (await Promise.all((await files(kind)).map((f) => readFile(f, 'utf8')))).join('')
  await s.until(async () => (await text('peers')).includes(',total,,,,,8000000000,'), 'a total row with the peer')
  const peers = (await text('peers')).split('\n')
  assert.equal(peers[0], PEERS_HEADER)
  const total = peers.find((l) => l.includes(',total,,,,,8000000000,'))!
  // One announcing peer, serving two experts, with the bytes relayed for it.
  assert.match(total, /,total,,,,,8000000000,0,0,2,1,,0,(150|0),,,,,,,,,,0$/)
  assert.ok(
    peers.some((l) => /,total,,,,,8000000000,0,0,2,1,,0,150,/.test(l)),
    peers.join('\n'),
  )
  // The network row carries the relay's own figures: lag, memory, reservation, subscriber.
  assert.ok(
    peers.some((l) => /,network,1,1,0,\d+,0,0,1,6,\d+,,,,7,90000000,40000000,1,1,/.test(l)),
    peers.join('\n'),
  )
  await s.until(async () => (await text('reports')).split('\n').length > 2, 'the report row')
  const reports = (await text('reports')).split('\n')
  assert.equal(reports[0], REPORTS_HEADER)
  assert.match(reports[1], /^\S+,"x",,,0,0,0,"other","other",0,5,/)
  assert.ok((await text('counts')).includes(',nodes,all,,1'))
  assert.ok(
    s.lines.some((l) => l.t === 'reset'),
    'a tick starts a new lag window',
  )
  // The history holds the tick, and the admin history reads the files.
  const history = (await (await fetch(`http://127.0.0.1:${port}/stats/history`)).json()) as { points: unknown[] }
  assert.equal(history.points.length, 1)
  const live = (await (await fetch(`http://127.0.0.1:${port}/admin/api/live`, { headers: auth })).json()) as {
    peers: { count: number; rows: { peer: string }[] }
  }
  assert.equal(live.peers.count, 1)
  assert.equal(live.peers.rows[0].peer, PEER)
  const h = (await (await fetch(`http://127.0.0.1:${port}/admin/api/history`, { headers: auth })).json()) as {
    statistics: boolean
    peers: { count: number }
  }
  assert.equal(h.statistics, true)
  assert.equal(h.peers.count, 1)
  // The peer leaves: its announce is forgotten, and no file ever named it.
  clearInterval(announcing)
  s.send({ t: 'close', id: '1', peer: PEER })
  await s.until(async () => /,total,,,,,0,0,0,0,0,/.test(await text('peers')), 'a total row without the peer')
  s.child.stdin.end()
  assert.equal(await s.exited, 0)
  for (const f of await readdir(dir)) assert.ok(!(await readFile(join(dir, f), 'utf8')).includes(PEER), f)
  assert.ok((await readdir(dir)).includes('history.json'))
})

test('a taken stats port costs the HTTP answers, not the statistics; lines that are not JSON are ignored', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sidecar-port-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const taken = createServer()
  await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', () => resolve()))
  t.after(() => taken.close())
  const { port } = taken.address() as { port: number }
  const s = sidecar(() => ({ counters: newCounters() }))
  t.after(() => s.child.kill())
  s.child.stdin.write('not json\n')
  s.send({
    t: 'hello',
    v: 1,
    connections: [],
    options: { stats: join(dir, 'peers.csv'), statsPort: port, host: '127.0.0.1', intervalMs: 200 },
  })
  await s.until(() => s.logged('VRAM history and admin API not served'), 'the port error')
  await s.until(async () => (await readdir(dir)).some((f) => f.startsWith('peers-')), 'a tick')
  s.child.stdin.end()
  assert.equal(await s.exited, 0)
})
