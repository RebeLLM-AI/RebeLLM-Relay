// The relay's HTTP side as a client sees it: the fetch proxy, the VRAM history and the admin
// API on the stats port, and what is left of them when the sidecar is missing or dies.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ANNOUNCE_TOPIC,
  AUTH,
  KEY,
  RELAY_BIN,
  b64,
  enc,
  freePort,
  peer,
  startRelay,
  stopAll,
  waitFor,
} from './harness.ts'

const GB = 2 ** 30
const DAY = 86_400_000
const BUCKET_MS = 6 * 3600_000
const MAX_VALUES = 72
const STATS_INTERVAL_MS = 5 * 60_000
// Midnight UTC starts a bucket.
const T0 = Date.parse('2026-09-20T00:00:00.000Z')
const ID = '12D3KooWQSPFiaqTCTY9whhkWQpHQSbhawEuG9zCki6bLermCBJH'
const PEERS_HEADER =
  'time,row,transport,model,gpu,precision,vram_bytes,budget_bytes,loaded,served,calls_per_sec,app,ram_bytes,relayed_bytes,loop_lag_ms,rss_bytes,heap_bytes,reservations,subscribers,opened,streams,refused,tokens,calls_per_sec_sum'

/**
 * peers.csv over `days` days of five-minute ticks: in bucket i the budgets are (10 + i) GB plus
 * j kB for tick j, peers 1, 2, 3 in turn; each tick also has a peer and a network row.
 */
function peersCsv(days: number) {
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
async function writeDaily(dir: string, text: string) {
  const days = new Map<string, string[]>()
  for (const line of text.split('\n').slice(1).filter(Boolean)) {
    const day = line.slice(0, 10)
    days.set(day, [...(days.get(day) ?? [PEERS_HEADER]), line])
  }
  for (const [day, lines] of days) await writeFile(join(dir, `peers-${day}.csv`), `${lines.join('\n')}\n`)
  return [...days.keys()]
}

/** The expected point of bucket i of peersCsv. */
const pointOf = (i: number) => ({
  t: T0 + i * BUCKET_MS,
  median: (10 + i) * GB + 35_000,
  min: (10 + i) * GB,
  max: (10 + i) * GB + 71_000,
  peers: 2,
})

const points = async (url: string) => ((await (await fetch(url)).json()) as { points: unknown[] }).points

test('after a restart the relay holds the history of its peers.csv before the first tick', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-history-'))
  try {
    const file = join(dir, 'peers.csv')
    await writeFile(file, peersCsv(2))
    const r = await startRelay({ stats: file, admin: false })
    try {
      assert.deepEqual(
        await points(`${r.statsUrl}/stats/history`),
        Array.from({ length: 8 }, (_, i) => pointOf(i)),
      )
    } finally {
      await r.stop()
    }
    // Without statistics there is no history: nothing even listens for it.
    const none = await startRelay({ admin: false })
    try {
      await assert.rejects(fetch(`${none.statsUrl}/stats/history`))
    } finally {
      await none.stop()
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('after a restart the relay holds the history of its daily peers files before the first tick', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-history-'))
  try {
    assert.deepEqual(await writeDaily(dir, peersCsv(2)), ['2026-09-20', '2026-09-21'])
    const r = await startRelay({ stats: join(dir, 'peers.csv'), admin: false })
    try {
      assert.deepEqual(
        await points(`${r.statsUrl}/stats/history`),
        Array.from({ length: 8 }, (_, i) => pointOf(i)),
      )
    } finally {
      await r.stop()
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('the relay serves the history rebuilt from --stats on --stats-port', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-history-'))
  const file = join(dir, 'peers.csv')
  await writeFile(file, peersCsv(1))
  const r = await startRelay({ stats: file, admin: false })
  try {
    assert.ok(r.lines.includes(`VRAM history on 127.0.0.1:${r.statsPort}/stats/history`))
    const res = await fetch(`${r.statsUrl}/stats/history?days=36500`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300')
    assert.deepEqual(((await res.json()) as { points: unknown[] }).points, [0, 1, 2, 3].map(pointOf))
    assert.equal((await fetch(`${r.statsUrl}/stats/peers`)).status, 404)
    // Without an admin key every admin path is 404.
    assert.equal((await fetch(`${r.statsUrl}/admin/api/live`)).status, 404)
  } finally {
    await r.stop()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

/** Runs the relay until `line` is printed; `started` rejects with the output if it exits first. */
function relayProcess(args: string[], line: string) {
  const child = spawn(RELAY_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  const started = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Object.assign(new Error(`no "${line}" line:\n${out}`), { out, code: null })),
      60_000,
    )
    const on = (d: Buffer) => {
      out += d
      if (out.includes(line)) resolve(clearTimeout(timer))
    }
    child.stdout.on('data', on)
    child.stderr.on('data', on)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(Object.assign(new Error(`relay exited with ${code}:\n${out}`), { out, code }))
    })
  })
  started.catch(() => undefined)
  return { started, stop: () => void child.kill() }
}

test('the relay serves the admin API with --admin-key, and stops for a malformed key', async (t) => {
  const r = await startRelay()
  t.after(() => r.stop())
  assert.ok(r.lines.includes(`admin API on 127.0.0.1:${r.statsPort}/admin/api/`))
  const url = r.statsUrl
  let res = await fetch(`${url}/admin/api/live`)
  assert.equal(res.status, 401)
  assert.match(res.headers.get('www-authenticate') ?? '', /^Basic realm="RebeLLM admin"/)
  res = await fetch(`${url}/admin/api/live`, {
    headers: { authorization: `Basic ${Buffer.from('admin:wrong').toString('base64')}` },
  })
  assert.equal(res.status, 401)
  res = await fetch(`${url}/admin/api/live`, { headers: AUTH })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const live = (await res.json()) as { statistics: boolean; connections: { open: number }; peerId: string }
  assert.equal(live.statistics, false)
  assert.equal(live.connections.open, 0)
  assert.equal(live.peerId, r.peerId)
  const h = (await (await fetch(`${url}/admin/api/history`, { headers: AUTH })).json()) as { statistics: boolean }
  assert.equal(h.statistics, false)
  assert.equal((await fetch(`${url}/admin/api/history?days=0`, { headers: AUTH })).status, 400)
  // Without --stats there is no history to pass on to.
  assert.equal((await fetch(`${url}/stats/history`)).status, 404)

  const dir = await mkdtemp(join(tmpdir(), 'rebellm-admin-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const base = ['--host', '127.0.0.1', '--port', String(await freePort()), '--key', join(dir, 'k.bin')]
  const bad = relayProcess([...base, '--admin-key', 'not-a-key'], 'listening on')
  t.after(bad.stop)
  await assert.rejects(
    bad.started,
    (e: { out: string; code: number }) => /invalid admin key/.test(e.out) && e.code !== 0,
  )
})

test('the admin key also comes from the environment, and a counted peer shows in the live snapshot', async () => {
  // 9092 is the default stats port with an admin key; this relay gets another, also through the environment.
  const statsPort = await freePort()
  const r = await startRelay({
    admin: false,
    env: { REBELLM_ADMIN_KEY: KEY, REBELLM_STATS_PORT: String(statsPort) },
    ready: `admin API on 127.0.0.1:${statsPort}/admin/api/`,
  })
  const client = await peer({ listen: [`${r.ma}/p2p-circuit`], pubsub: true })
  try {
    const url = `http://127.0.0.1:${statsPort}`
    client.services.pubsub.subscribe(ANNOUNCE_TOPIC)
    let tries = 0
    const live = async () =>
      (await (await fetch(`${url}/admin/api/live`, { headers: AUTH })).json()) as { counters: Record<string, number> }
    await waitFor(async () => {
      const announce = enc({ v: 1, model: 'm', layers: 1, experts: 8, served: b64([5]), n: tries })
      if (tries++ % 10 === 0) client.services.pubsub.publish(ANNOUNCE_TOPIC, announce).catch(() => undefined)
      const c = (await live()).counters
      // A peer connects, reserves a slot and publishes an announce the validator accepts.
      return c.connectionsOpened === 1 && c.reservationsGranted >= 1 && c.announcesAccepted >= 1
    }, r.lines)
  } finally {
    await stopAll(client, r)
  }
})

test('the relay serves the fetch proxy on --fetch-port', async () => {
  const fetchPort = await freePort()
  const r = await startRelay({
    admin: false,
    args: ['--fetch-port', String(fetchPort)],
    ready: `fetch proxy on 127.0.0.1:${fetchPort}/fetch`,
  })
  try {
    const res = await fetch(`http://127.0.0.1:${fetchPort}/fetch`)
    assert.equal(res.status, 400)
    assert.deepEqual(await res.json(), { error: 'url is missing' })
    assert.equal((await fetch(`http://127.0.0.1:${fetchPort}/fetch?url=http%3A%2F%2F127.0.0.1%2F`)).status, 403)
    assert.equal((await fetch(`http://127.0.0.1:${fetchPort}/other`)).status, 404)
    assert.equal((await fetch(`http://127.0.0.1:${fetchPort}/fetch?url=x`, { method: 'POST' })).status, 405)
  } finally {
    await r.stop()
  }
})

test('the fetch proxy is off by default, and --help prints the usage of the Node.js relay', async () => {
  const r = await startRelay({ admin: false })
  try {
    assert.ok(!r.lines.some((l) => l.includes('fetch proxy')))
  } finally {
    await r.stop()
  }
  const help = relayProcess(['--help'], '--admin-key')
  try {
    await help.started
  } finally {
    help.stop()
  }
  const bad = relayProcess(['--port', '70000'], 'listening on')
  await assert.rejects(
    bad.started,
    (e: { out: string; code: number }) => /invalid port 70000/.test(e.out) && e.code !== 0,
  )
})

const DYING = fileURLToPath(new URL('fixtures/dying-sidecar.ts', import.meta.url))

test('a sidecar that dies costs the statistics for a moment, not a connection; the relay starts it again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-sidecar-'))
  // The first sidecar exits two seconds after it started serving; the next ones stay.
  const r = await startRelay({ env: { REBELLM_SIDECAR: DYING, DYING_SIDECAR_MARK: join(dir, 'died') } })
  const client = await peer({ pubsub: true })
  const other = await peer({ pubsub: true })
  const got: number[] = []
  other.services.pubsub.addEventListener('message', () => got.push(1))
  for (const p of [client, other]) p.services.pubsub.subscribe(ANNOUNCE_TOPIC)
  try {
    await client.dial(r.ma)
    await other.dial(r.ma)
    await waitFor(() => r.lines.some((l) => l.includes('statistics sidecar exited')), r.lines)
    assert.ok(r.lines.some((l) => /the relay goes on without statistics and tries again in 1 s/.test(l)))
    // The relay kept both peers and still passes their announces on.
    let tries = 0
    await waitFor(() => {
      const announce = enc({ v: 1, model: 'm', layers: 1, experts: 8, served: b64([5]), n: tries })
      if (tries++ % 10 === 0) client.services.pubsub.publish(ANNOUNCE_TOPIC, announce).catch(() => undefined)
      return got.length > 0
    }, r.lines)
    assert.equal(client.getConnections().length, 1)
    assert.equal(other.getConnections().length, 1)
    // The new sidecar serves again, and knows the connections that were open all along.
    await waitFor(
      async () => {
        const res = await fetch(`${r.statsUrl}/admin/api/live`, { headers: AUTH }).catch(() => undefined)
        return res?.status === 200 && ((await res.json()) as { connections: { open: number } }).connections.open === 2
      },
      r.lines,
      30_000,
    )
    assert.equal(r.lines.filter((l) => l.startsWith('admin API on ')).length, 2)
  } finally {
    await stopAll(client, other, r)
    await rm(dir, { recursive: true, force: true })
  }
})

test('a sidecar that cannot be started leaves a relay that connects, relays and gossips', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-nosidecar-'))
  const r = await startRelay({
    admin: false,
    args: ['--stats', join(dir, 'peers.csv'), '--stats-port', String(await freePort())],
    env: { REBELLM_NODE: 'rebellm-no-such-node-binary' },
  })
  const client = await peer({ listen: [`${r.ma}/p2p-circuit`], pubsub: true })
  const other = await peer({ pubsub: true })
  const got: number[] = []
  other.services.pubsub.addEventListener('message', () => got.push(1))
  for (const p of [client, other]) p.services.pubsub.subscribe(ANNOUNCE_TOPIC)
  try {
    await waitFor(() => r.lines.some((l) => l.includes('statistics sidecar not started')), r.lines)
    await other.dial(r.ma)
    await waitFor(() => client.getMultiaddrs().some((a) => a.toString().includes('/p2p-circuit')), r.lines)
    let tries = 0
    await waitFor(() => {
      const announce = enc({ v: 1, model: 'm', layers: 1, experts: 8, served: b64([5]), n: tries })
      if (tries++ % 10 === 0) client.services.pubsub.publish(ANNOUNCE_TOPIC, announce).catch(() => undefined)
      return got.length > 0
    }, r.lines)
  } finally {
    await stopAll(client, other, r)
    await rm(dir, { recursive: true, force: true })
  }
})
