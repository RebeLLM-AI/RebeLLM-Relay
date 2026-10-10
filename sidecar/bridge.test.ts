import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bridge, liveOf } from './bridge.ts'
import { ANNOUNCE_TOPIC, RelayStats, announceFields, newCounters } from './stats.ts'

const T = new Date('2026-09-25T10:00:00.000Z')
const b64 = (bytes) => Buffer.from(bytes).toString('base64')
const enc = (o) => new TextEncoder().encode(JSON.stringify(o))
const line = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
const announce = (o) => ({ v: 1, model: 'qwen3-30b', layers: 2, experts: 4, addrs: [], ...o })

/** A bridge whose sent lines are kept, answering each `get` with `snapshot` when it has one. */
function bridged(snapshot?: unknown, o = {}) {
  const sent: { t?: string; id?: number }[] = []
  const bridge = new Bridge((l) => {
    sent.push(l)
    if (l.t === 'get' && snapshot) queueMicrotask(() => bridge.receive({ t: 'res', id: l.id, snapshot }))
  }, o)
  return { bridge, sent }
}

const conn = (id, peer, addr, open = T.getTime()) => ({ id, peer, addr, open })

test('the connections follow hello, open and close; a close tells its peer and the connection id', () => {
  const { bridge } = bridged()
  const closed: unknown[] = []
  bridge.addEventListener('connection:close', (e) => closed.push((e as CustomEvent).detail))
  bridge.receive({
    t: 'hello',
    v: 1,
    options: { stats: '/data/peers.csv', statsPort: 9092 },
    connections: [conn('1', 'peerA', '/ip4/172.19.0.5/tcp/1/ws'), conn('2', 'peerB', '/ip4/172.19.0.5/tcp/2/ws')],
  })
  assert.deepEqual(bridge.options, { stats: '/data/peers.csv', statsPort: 9092 })
  bridge.receive({ t: 'open', conn: conn('3', 'peerA', '/ip4/172.19.0.5/tcp/3/ws', T.getTime() + 5) })
  assert.deepEqual(
    bridge.getConnections().map((c) => c.id),
    ['1', '2', '3'],
  )
  assert.deepEqual(bridge.getConnections('peerA')[1], {
    id: '3',
    remotePeer: 'peerA',
    remoteAddr: '/ip4/172.19.0.5/tcp/3/ws',
    timeline: { open: T.getTime() + 5 },
  })
  // A replaced connection closes while the peer stays on its newer one.
  bridge.receive({ t: 'close', id: '1', peer: 'peerA' })
  assert.deepEqual(closed, [{ remotePeer: 'peerA', id: '1' }])
  assert.equal(bridge.getConnections('peerA').length, 1)
  assert.equal(bridge.getConnections('peerC').length, 0)
  // A relay that starts the sidecar again says hello again: the table starts over.
  bridge.receive({ t: 'hello', v: 1, options: {}, connections: [conn('9', 'peerZ', '/ip4/1.2.3.4/tcp/1/ws')] })
  assert.deepEqual(
    bridge.getConnections().map((c) => c.remotePeer),
    ['peerZ'],
  )
  // Lines it does not know, or cannot read, change nothing.
  bridge.receive({ t: 'future', x: 1 })
  bridge.receive({ t: 'open', conn: { peer: 'no id' } })
  bridge.receive(null as never)
  assert.equal(bridge.getConnections().length, 1)
})

test('accepted announces arrive as pubsub messages, reports and relayed bytes as events, with their bytes', () => {
  const { bridge } = bridged()
  const messages: { topic: string; from: string; data: Uint8Array }[] = []
  const reports: { peer: string; data: Uint8Array }[] = []
  const relayed: unknown[] = []
  bridge.services.pubsub.addEventListener('message', (e) => messages.push((e as CustomEvent).detail))
  bridge.addEventListener('report', (e) => reports.push((e as CustomEvent).detail))
  bridge.addEventListener('relayed', (e) => relayed.push((e as CustomEvent).detail))
  const a = announce({ served: b64([0b11]), vramBytes: 4e9 })
  bridge.receive({ t: 'announce', peer: 'peerA', data: line(a) })
  bridge.receive({ t: 'report', peer: 'peerB', data: line({ v: 1, trunk: { tokens: 5 } }) })
  bridge.receive({ t: 'relayed', peers: ['peerB', 'peerA'], bytes: 150 })
  assert.equal(messages[0].topic, ANNOUNCE_TOPIC)
  assert.equal(messages[0].from, 'peerA')
  assert.deepEqual(announceFields(messages[0].data), announceFields(enc(a)))
  assert.equal(reports[0].peer, 'peerB')
  assert.deepEqual(JSON.parse(new TextDecoder().decode(reports[0].data)), { v: 1, trunk: { tokens: 5 } })
  assert.deepEqual(relayed, [{ peers: ['peerB', 'peerA'], bytes: 150 }])
})

test('a refresh asks the relay for a snapshot and takes its counters, gauges and loop lag from it', async () => {
  const snapshot = {
    peerId: 'RELAY',
    counters: { ...newCounters(), connectionsOpened: 7, tokens: 2 },
    reservations: 3,
    gossip: { announce: { subscribers: 4 } },
    process: { rssBytes: 90e6, heapUsedBytes: 40e6, loopLagMs: 15 },
  }
  const { bridge, sent } = bridged(snapshot)
  const counters = bridge.counters
  // Before the first snapshot: nothing counted, nothing gauged, no lag.
  assert.deepEqual(counters, newCounters())
  assert.deepEqual(bridge.probe(), {
    rssBytes: undefined,
    heapBytes: undefined,
    reservations: undefined,
    subscribers: undefined,
  })
  assert.deepEqual(await bridge.refresh(), snapshot)
  assert.deepEqual(sent, [{ t: 'get', id: 1 }])
  // The same object the statistics hold, updated in place.
  assert.equal(bridge.counters, counters)
  assert.equal(counters.connectionsOpened, 7)
  assert.equal(counters.tokens, 2)
  // The probe reads the relay's memory, its reservations and the announce subscribers.
  assert.deepEqual(bridge.probe(), { rssBytes: 90e6, heapBytes: 40e6, reservations: 3, subscribers: 4 })
  // The relay's lag is whole ms beyond its sampling interval; RelayStats reads it back as such.
  const stats = new RelayStats({ file: 'peers.csv', now: () => T.getTime(), loopDelay: bridge.loopDelay })
  assert.equal(stats.loopLagMs(), 15)
  bridge.loopDelay.reset()
  assert.deepEqual(sent.at(-1), { t: 'reset' })
})

test('a relay that does not answer gives no snapshot after the timeout, and a late answer is dropped', async () => {
  const { bridge, sent } = bridged(undefined, { timeoutMs: 30 })
  assert.equal(await bridge.refresh(), undefined)
  assert.equal(bridge.snapshot, undefined)
  // The answer to a question nobody waits for any more still updates the snapshot.
  bridge.receive({ t: 'res', id: sent[0].id, snapshot: { reservations: 1 } })
  assert.equal(bridge.probe().reservations, 1)
  // An answer without a snapshot resolves the wait with nothing.
  const waiting = bridge.refresh()
  bridge.receive({ t: 'res', id: sent[1].id, snapshot: null })
  assert.equal(await waiting, undefined)
})

test('the live answer is the relay snapshot with the announcing peers of the statistics', async () => {
  const snapshot = { time: 1, peerId: 'RELAY', statistics: true, connections: { open: 1 }, peers: null }
  const { bridge } = bridged(snapshot)
  const stats = new RelayStats({ file: 'peers.csv', now: () => T.getTime() })
  const a = enc(announce({ served: b64([0b11]), vramBytes: 4e9, budgetBytes: 1e9, callsPerSec: 0.5 }))
  stats.record('a', 'ws', a)
  stats.recordRelayed(['a'], 70)
  const live = (await liveOf(bridge, () => stats.live())()) as { peers: ReturnType<RelayStats['live']> }
  assert.deepEqual({ ...live, peers: null }, snapshot)
  assert.deepEqual(Object.keys(live), Object.keys(snapshot))
  assert.equal(live.peers.count, 1)
  assert.equal(live.peers.vramBytes, 4e9)
  assert.equal(live.peers.served, 2)
  assert.equal(live.peers.relayedBytes, 70)
  assert.deepEqual(live.peers.replicas, { min: 0, median: 0, max: 1, none: 6 })
  assert.deepEqual(live.peers.rows[0], {
    peer: 'a',
    transport: 'ws',
    ...announceFields(a),
    relayedBytes: 70,
    ageSec: 0,
  })
  // Without statistics the peers stay null; without an answer there is no live answer.
  assert.equal(((await liveOf(bridge)()) as { peers: unknown }).peers, null)
  assert.equal(await liveOf(bridged(undefined, { timeoutMs: 20 }).bridge)(), undefined)
})
