// The relay, a Rust process, as the statistics see it: its connections mirrored from the
// lines it sends, its accepted announces and usage reports as events, and its counters,
// gauges and loop lag from the last snapshot it answered with. One JSON object per line each
// way; see openspec/specs/relay-statistics.
import { ANNOUNCE_TOPIC, LOOP_RESOLUTION_MS, newCounters, type Counters, type Probe } from './stats.ts'

/** Version of the line protocol the relay names in `hello`. */
export const PROTOCOL = 1
/** How long a snapshot is waited for; a relay that is busy or gone answers nothing. */
export const SNAPSHOT_TIMEOUT_MS = 5000

export interface Conn {
  id: string
  remotePeer: string
  remoteAddr: string
  timeline: { open: number }
}
/** The relay's live answer without the announcing peers. */
export type Snapshot = {
  counters?: Partial<Counters>
  reservations?: number
  gossip?: { announce?: { subscribers?: number } }
  process?: { rssBytes?: number; heapUsedBytes?: number; loopLagMs?: number | null }
  [key: string]: unknown
}
/** The relay's options the sidecar needs, from `hello`. */
export type Options = {
  stats?: string | null
  statsPort?: number
  host?: string
  adminKey?: string | null
  intervalMs?: number | null
}
type Line = { t?: string; [key: string]: unknown }

const text = (v: unknown) => (typeof v === 'string' ? v : '')
const bytes = (v: unknown) => Uint8Array.from(Buffer.from(text(v), 'base64'))

/**
 * The node the statistics read (watchStats): `getConnections`, `services.pubsub` with a
 * `message` per accepted announce, `connection:close`, `relayed` and `report` events, and the
 * relay's `counters`, `probe` and `loopDelay`, which `refresh` brings up to date.
 */
export class Bridge extends EventTarget {
  services = { pubsub: new EventTarget() }
  /** The relay's counters at the last snapshot; one object, updated in place. */
  counters: Counters = newCounters()
  /** The last snapshot, undefined before the first. */
  snapshot: Snapshot | undefined
  /** The options of the last `hello`. */
  options: Options | undefined
  timeoutMs: number
  #send: (line: Line) => void
  #conns = new Map<string, Conn>()
  #waiting = new Map<number, (snapshot: Snapshot | undefined) => void>()
  #nextId = 1

  /** `send` writes one line to the relay. */
  constructor(send: (line: Line) => void, { timeoutMs = SNAPSHOT_TIMEOUT_MS } = {}) {
    super()
    this.#send = send
    this.timeoutMs = timeoutMs
  }

  /** The relay's open connections, or those of one peer. */
  getConnections(peer?: unknown): Conn[] {
    const all = [...this.#conns.values()]
    return peer === undefined ? all : all.filter((c) => c.remotePeer === String(peer))
  }

  /** The network row's gauges: the relay's memory, reservations and announce subscribers. */
  probe = (): Probe => ({
    rssBytes: this.snapshot?.process?.rssBytes,
    heapBytes: this.snapshot?.process?.heapUsedBytes,
    reservations: this.snapshot?.reservations,
    subscribers: this.snapshot?.gossip?.announce?.subscribers,
  })

  /**
   * The relay's loop lag in the shape of Node's delay histogram, which RelayStats reads: the
   * relay reports whole ms beyond its sampling interval, a histogram ns including it.
   */
  loopDelay = {
    percentile: () => ((this.snapshot?.process?.loopLagMs ?? 0) + LOOP_RESOLUTION_MS) * 1e6,
    reset: () => this.#send({ t: 'reset' }),
  }

  /** Asks the relay for a snapshot; undefined when it does not answer in time. */
  refresh(): Promise<Snapshot | undefined> {
    const id = this.#nextId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id)
        resolve(undefined)
      }, this.timeoutMs)
      timer.unref?.()
      this.#waiting.set(id, (snapshot) => {
        clearTimeout(timer)
        resolve(snapshot)
      })
      this.#send({ t: 'get', id })
    })
  }

  /** Takes one line of the relay. Unknown lines are ignored, so a newer relay can say more. */
  receive(m: Line) {
    if (!m || typeof m !== 'object') return
    if (m.t === 'hello') {
      this.options = (m.options ?? {}) as Options
      this.#conns.clear()
      for (const c of Array.isArray(m.connections) ? m.connections : []) this.#open(c)
      this.dispatchEvent(new CustomEvent('hello', { detail: m }))
    } else if (m.t === 'open') {
      this.#open(m.conn)
    } else if (m.t === 'close') {
      const id = text(m.id)
      this.#conns.delete(id)
      this.dispatchEvent(new CustomEvent('connection:close', { detail: { remotePeer: text(m.peer), id } }))
    } else if (m.t === 'announce') {
      const detail = { topic: ANNOUNCE_TOPIC, from: text(m.peer), data: bytes(m.data) }
      this.services.pubsub.dispatchEvent(new CustomEvent('message', { detail }))
    } else if (m.t === 'report') {
      this.dispatchEvent(new CustomEvent('report', { detail: { peer: text(m.peer), data: bytes(m.data) } }))
    } else if (m.t === 'relayed') {
      const peers = Array.isArray(m.peers) ? m.peers.map(String) : []
      this.dispatchEvent(new CustomEvent('relayed', { detail: { peers, bytes: Number(m.bytes) || 0 } }))
    } else if (m.t === 'res') {
      const snapshot = m.snapshot && typeof m.snapshot === 'object' ? (m.snapshot as Snapshot) : undefined
      if (snapshot) {
        this.snapshot = snapshot
        Object.assign(this.counters, snapshot.counters)
      }
      const done = this.#waiting.get(Number(m.id))
      this.#waiting.delete(Number(m.id))
      done?.(snapshot)
    }
  }

  #open(c: unknown) {
    const o = (c ?? {}) as { id?: unknown; peer?: unknown; addr?: unknown; open?: unknown }
    if (typeof o.id !== 'string') return
    this.#conns.set(o.id, {
      id: o.id,
      remotePeer: text(o.peer),
      remoteAddr: text(o.addr),
      timeline: { open: Number(o.open) || Date.now() },
    })
  }
}

/**
 * The admin page's live answer: a fresh snapshot of the relay with the announcing peers the
 * statistics hold; nothing while the relay does not answer.
 */
export function liveOf(bridge: Bridge, peers: () => unknown = () => null) {
  return async () => {
    const snapshot = await bridge.refresh()
    return snapshot && { ...snapshot, peers: peers() ?? null }
  }
}
