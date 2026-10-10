// Starts the built relay for a black-box test and answers what the Node.js relay's tests read
// from its JavaScript object: the address, the console lines, the live snapshot.
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { gossipsub } from '@libp2p/gossipsub'
import { identify } from '@libp2p/identify'
import { webSockets } from '@libp2p/websockets'
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr'
import { createLibp2p } from 'libp2p'
import { adminKey } from '../sidecar/admin.ts'

const exe = process.platform === 'win32' ? '.exe' : ''
const built = (name: string) => fileURLToPath(new URL(`../target/debug/${name}${exe}`, import.meta.url))
/** The binaries under test: scripts/compat.mjs names them, else a default Cargo build. */
export const RELAY_BIN = process.env.REBELLM_RELAY_BIN ?? built('rebellm-relay')
export const PEER_ID_BIN = process.env.REBELLM_PEER_ID_BIN ?? built('rebellm-relay-peer-id')
export const SIDECAR = fileURLToPath(new URL('../sidecar/index.ts', import.meta.url))

// Made-up credentials: tests never see a real login.
export const LOGIN = 'admin:secret-for-tests'
export const KEY = adminKey(LOGIN, 'relay.example')
export const AUTH = { authorization: `Basic ${Buffer.from(LOGIN).toString('base64')}` }

export const ANNOUNCE_TOPIC = 'rebellm/announce/1'
export const REPORT_TOPIC = 'rebellm/report/1'
export const MODEL_ACCESS_PROTOCOL = '/rebellm/model-access/1.0.0'
export const SIGNAL_DATA_BYTES = 128 * 1024

export const b64 = (bytes: Iterable<number>) => Buffer.from([...bytes]).toString('base64')
export const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o))

/** A port nobody listens on right now. */
export async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()))
  const { port } = s.address() as { port: number }
  await new Promise((resolve) => s.close(resolve))
  return port
}

/** Waits until `ok` holds; `say` describes the state when the wait times out. */
export async function waitFor(
  ok: () => unknown | Promise<unknown>,
  say: string[] | (() => unknown | Promise<unknown>) = [],
  ms = 20_000,
) {
  for (const end = Date.now() + ms; !(await ok());) {
    if (Date.now() > end) {
      const state = typeof say === 'function' ? await say() : say.join('\n')
      assert.fail(`timed out; state:\n${typeof state === 'string' ? state : JSON.stringify(state, null, 1)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** The live snapshot, as far as the tests read it. */
export interface Live {
  time: number
  peerId: string
  statistics: boolean
  modelTokens: boolean
  connections: {
    open: number
    peers: number
    byTransport: Record<string, number>
    medianAgeSec: number | null
    oldestAgeSec: number | null
  }
  reservations: number
  limits: Record<string, number>
  gossip: {
    peers: number
    announce: { subscribers: number; mesh: number }
    report: { subscribers: number; mesh: number }
  }
  throttle: { refused: number; addresses: number } | null
  counters: Record<string, number>
  process: Record<string, number | null>
  peers: null | {
    count: number
    vramBytes: number
    relayedBytes: number
    replicas: unknown
    rows: { peer: string; vramBytes?: number }[]
  }
}

export interface RelayOptions {
  /** Extra command line arguments. */
  args?: string[]
  env?: Record<string, string>
  /** A key file to keep the identity; a fresh one in the relay's temp directory otherwise. */
  key?: string
  /** Serve the admin API, which `live()` reads; on by default. */
  admin?: boolean
  /** Base path of the statistics. */
  stats?: string
  /** The line that says the relay is ready, when it is not the default one. */
  ready?: string
}

export interface RelayProcess {
  child: ChildProcess
  port: number
  statsPort: number
  statsUrl: string
  peerId: string
  /** The bootstrap addresses the relay printed. */
  addrs: string[]
  /** The first bootstrap address. */
  ma: Multiaddr
  /** Every console line so far, stdout and stderr. */
  lines: string[]
  live(): Promise<Live>
  /** Ends the process and waits for it. */
  stop(): Promise<void>
  exited: Promise<number | null>
}

/** Starts the relay on loopback and waits until it listens (and, with `admin`, serves the admin API). */
export async function startRelay(o: RelayOptions = {}): Promise<RelayProcess> {
  assert.ok(existsSync(RELAY_BIN), `no relay binary at ${RELAY_BIN}; run cargo build`)
  const dir = await mkdtemp(join(tmpdir(), 'relay-compat-'))
  const [port, statsPort] = [await freePort(), await freePort()]
  const admin = o.admin ?? true
  const args = ['--host', '127.0.0.1', '--port', String(port), '--key', o.key ?? join(dir, 'k.bin')]
  if (admin) args.push('--admin-key', KEY)
  if (o.stats) args.push('--stats', o.stats)
  if (admin || o.stats) args.push('--stats-port', String(statsPort))
  args.push(...(o.args ?? []))
  const child = spawn(RELAY_BIN, args, {
    env: { ...process.env, REBELLM_SIDECAR: SIDECAR, REBELLM_NODE: process.execPath, ...o.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines: string[] = []
  let partial = ''
  const take = (d: Buffer) => {
    const parts = (partial + d.toString()).split(/\r?\n/)
    partial = parts.pop() ?? ''
    lines.push(...parts)
  }
  child.stdout!.on('data', take)
  child.stderr!.on('data', take)
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
  let done = false
  exited.then(() => (done = true))
  const stop = async () => {
    if (!done) child.kill()
    await exited
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
  const waiting = [
    o.ready ?? 'model file tokens:',
    ...(admin ? [`admin API on 127.0.0.1:${statsPort}/admin/api/`] : []),
    ...(o.stats ? [`VRAM history on 127.0.0.1:${statsPort}/stats/history`] : []),
  ]
  try {
    await waitFor(
      () => {
        if (done) assert.fail(`the relay exited:\n${lines.join('\n')}`)
        return waiting.every((w) => lines.some((l) => l.includes(w)))
      },
      lines,
      60_000,
    )
  } catch (e) {
    await stop()
    throw e
  }
  const started = lines.find((l) => /^relay \S+ listening on /.test(l)) ?? ''
  const peerId = started.split(' ')[1]
  const first = lines.findIndex((l) => l.startsWith('bootstrap addresses'))
  const addrs: string[] = []
  for (let i = first + 1; lines[i]?.startsWith('  '); i++) addrs.push(lines[i].trim())
  const statsUrl = `http://127.0.0.1:${statsPort}`
  return {
    child,
    port,
    statsPort,
    statsUrl,
    peerId,
    addrs,
    ma: multiaddr(`/ip4/127.0.0.1/tcp/${port}/ws/p2p/${peerId}`),
    lines,
    exited,
    stop,
    async live() {
      const r = await fetch(`${statsUrl}/admin/api/live`, { headers: AUTH })
      assert.equal(r.status, 200, `live snapshot: ${r.status}`)
      return (await r.json()) as Live
    },
  }
}

export interface PeerOptions {
  listen?: string[]
  /** With gossipsub, as the web app configures it. */
  pubsub?: boolean
  services?: Record<string, unknown>
  privateKey?: unknown
  /** Leave the connection monitor on (the web app turns it off). */
  monitor?: boolean
}

/** A js-libp2p peer configured like the web app's, without WebRTC. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the services differ per test
export async function peer(o: PeerOptions = {}): Promise<any> {
  return createLibp2p({
    ...(o.privateKey ? { privateKey: o.privateKey as never } : {}),
    addresses: { listen: o.listen ?? [] },
    transports: [webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionMonitor: { enabled: o.monitor ?? false },
    services: {
      identify: identify(),
      ...(o.pubsub ? { pubsub: gossipsub({ allowPublishToZeroTopicPeers: true, emitSelf: false }) } : {}),
      ...o.services,
    },
  })
}

/** True once the peer listens on a circuit address: its reservation was granted. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const reserved = (p: any) => p.getMultiaddrs().some((a: Multiaddr) => a.toString().includes('/p2p-circuit'))

/** The circuit address of `target` through the relay. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const through = (relay: RelayProcess, target: any) =>
  multiaddr(`/ip4/127.0.0.1/tcp/${relay.port}/ws/p2p/${relay.peerId}/p2p-circuit/p2p/${target.peerId.toString()}`)

/** Stops peers and relays, whatever state they are in. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function stopAll(...things: ({ stop(): Promise<any> } | undefined)[]) {
  await Promise.all(things.map((t) => t?.stop().catch(() => undefined)))
}
