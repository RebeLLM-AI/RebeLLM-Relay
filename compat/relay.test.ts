// The Node.js relay's tests of a running relay, against the Rust binary: every peer here is
// js-libp2p in the versions the web app ships, so each test is also a wire compatibility test.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { connect, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { ping } from '@libp2p/ping'
import { multiaddr } from '@multiformats/multiaddr'
import {
  ANNOUNCE_TOPIC,
  MODEL_ACCESS_PROTOCOL,
  PEER_ID_BIN,
  REPORT_TOPIC,
  SIGNAL_DATA_BYTES,
  b64,
  enc,
  peer,
  reserved,
  startRelay,
  stopAll,
  through,
  waitFor,
} from './harness.ts'

const announceOf = (o = {}) => enc({ v: 1, model: 'm', layers: 1, experts: 8, served: b64([5]), ...o })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const E8 = ',,,,,,,,'
const PEERS_HEADER =
  'time,row,transport,model,gpu,precision,vram_bytes,budget_bytes,loaded,served,calls_per_sec,app,ram_bytes,relayed_bytes,loop_lag_ms,rss_bytes,heap_bytes,reservations,subscribers,opened,streams,refused,tokens,calls_per_sec_sum'
const HOT_HEADER = 'time,layer,expert,demand'

/** The file server's check of a token, as nginx's secure link module computes it. */
const signature = (secret: string, e: number) => createHash('md5').update(`${e}/models/${secret}`).digest('base64url')

test('starts on a free port with a stable key and stops', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-start-'))
  try {
    const key = join(dir, 'k.bin')
    const r = await startRelay({ key, admin: false, args: ['--announce', '/dns4/r.example/tcp/443/wss'] })
    assert.ok(r.port > 0)
    assert.match(r.addrs[0], new RegExp(`^/dns4/r.example/tcp/443/wss/p2p/${r.peerId}$`))
    // The listen socket accepts WebSocket upgrades.
    const ws = new WebSocket(`ws://127.0.0.1:${r.port}`)
    await new Promise((resolve, reject) => {
      ws.onopen = resolve
      ws.onerror = () => reject(new Error('no WebSocket upgrade'))
    })
    ws.close()
    await r.stop()
    assert.notEqual(r.child.exitCode ?? r.child.signalCode, null, 'the process ended')
    const again = await startRelay({ key })
    try {
      assert.equal(again.peerId, r.peerId)
      assert.match(again.addrs[0], /^\/ip4\/127\.0\.0\.1\/tcp\/\d+\/ws\/p2p\//)
      // Without a stats file nothing is kept or written.
      const live = await again.live()
      assert.equal(live.statistics, false)
      assert.equal(live.peers, null)
      assert.deepEqual(await readdir(dir), ['k.bin'])
    } finally {
      await again.stop()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('with a models secret a connected peer gets a token on the model access protocol; without one it is unsupported', async () => {
  const secret = 'f00d'
  const r = await startRelay({ args: ['--models-secret', secret] })
  const bare = await startRelay()
  const client = await peer()
  try {
    assert.ok(r.lines.includes('model file tokens: on (--models-secret)'))
    assert.ok(bare.lines.includes('model file tokens: off; the model files must be open'))
    const before = Math.floor(Date.now() / 1000)
    const stream = await client.dialProtocol(r.ma, MODEL_ACCESS_PROTOCOL)
    // One line, as the browser reads it: a close racing the dialer's negotiation may never arrive.
    let text = ''
    for await (const chunk of stream) {
      text += new TextDecoder().decode(chunk.subarray())
      if (text.includes('\n')) break
    }
    assert.ok(text.endsWith('\n'), text)
    const t = JSON.parse(text)
    assert.equal(t.v, 1)
    assert.ok(t.e >= before + 3600 && t.e <= Math.floor(Date.now() / 1000) + 3600, String(t.e))
    assert.equal(t.s, signature(secret, t.e))
    assert.notEqual(t.s, signature('other', t.e))
    assert.equal((await r.live()).counters.tokens, 1)
    assert.equal((await r.live()).modelTokens, true)
    assert.equal((await bare.live()).modelTokens, false)
    await assert.rejects(client.dialProtocol(bare.ma, MODEL_ACCESS_PROTOCOL), /protocol/i)
  } finally {
    await stopAll(client, r, bare)
  }
})

test('a real relay under watch prints a peer that connects, reserves a slot and is reached through it', async () => {
  const r = await startRelay({ args: ['--verbose'] })
  const lines = r.lines
  const has = (re: RegExp) => lines.some((l) => re.test(l))
  const client = await peer({ listen: [`${r.ma}/p2p-circuit`] })
  const other = await peer()
  try {
    const id = client.peerId.toString().slice(-8)
    await waitFor(() => has(/ reserve /), lines)
    assert.ok(has(new RegExp(`^\\S+ open ${id} ws$`)), lines.join('\n'))
    assert.ok(has(new RegExp(`^\\S+ reserve ${id} ws$`)), lines.join('\n'))
    assert.ok(!has(/note:/), lines.join('\n'))
    // A second peer reaches the first through the relay: one stream line naming both ends.
    await other.dial(through(r, client))
    const from = other.peerId.toString().slice(-8)
    await waitFor(() => has(/ stream /), lines)
    assert.ok(has(new RegExp(`^\\S+ stream ${id} ws from=${from}$`)), lines.join('\n'))
    // Without statistics the counters still see the reservation and the relayed stream.
    const c = (await r.live()).counters
    assert.ok(c.connectionsOpened >= 2 && c.reservationsGranted >= 1 && c.relayedStreams >= 1, JSON.stringify(c))
    assert.equal(c.reservationsRefused, 0)
    await waitFor(async () => (await r.live()).counters.relayedBytes > 0, lines)
    // The peer leaves: a close line, and the status line every ten seconds is not needed for it.
    await client.stop()
    await waitFor(() => has(new RegExp(`^\\S+ close ${id} ws$`)), lines)
  } finally {
    await stopAll(other, client, r)
  }
})

test('a relay lets 256 relayed connections through each link by default; with 1 it refuses a peer its second relayed connection', async () => {
  const r = await startRelay({ env: { REBELLM_TEST_STREAMS_PER_LINK: '1' } })
  const listen = [`${r.ma}/p2p-circuit`]
  const targets = await Promise.all([peer({ listen }), peer({ listen })])
  const dialer = await peer()
  try {
    await waitFor(
      () => targets.every(reserved),
      () => 'reservations',
    )
    await dialer.dial(through(r, targets[0]))
    await assert.rejects(dialer.dial(through(r, targets[1])))
  } finally {
    await stopAll(dialer, ...targets, r)
  }
})

test('the link a peer is dialed through is bounded like the one dialing', async () => {
  const r = await startRelay({ env: { REBELLM_TEST_STREAMS_PER_LINK: '1' } })
  const target = await peer({ listen: [`${r.ma}/p2p-circuit`] })
  const dialers = await Promise.all([peer(), peer()])
  try {
    await waitFor(
      () => reserved(target),
      () => 'reservation',
    )
    await dialers[0].dial(through(r, target))
    await assert.rejects(dialers[1].dial(through(r, target)))
  } finally {
    await stopAll(...dialers, target, r)
  }
})

test('a relayed connection is for signalling only: limited, no stream without opt-in, cut past 128 KiB', async () => {
  const r = await startRelay()
  const target = await peer({ listen: [`${r.ma}/p2p-circuit`] })
  const dialer = await peer()
  try {
    await target.handle('/test/expert/1', () => undefined)
    let received = 0
    await target.handle(
      '/test/signal/1',
      (stream) => stream.addEventListener('message', (e) => (received += e.data.byteLength)),
      { runOnLimitedConnection: true },
    )
    await waitFor(
      () => reserved(target),
      () => 'reservation',
    )
    const conn = await dialer.dial(through(r, target))
    assert.ok(conn.limits, 'the relayed connection is limited')
    // Two minutes and 128 KiB, as the relay states them to both ends.
    // What is left of them: the relayed connection's own handshake already went through.
    const left = { bytes: Number(conn.limits.bytes), seconds: Number(conn.limits.seconds) }
    assert.ok(left.bytes <= SIGNAL_DATA_BYTES && left.bytes > SIGNAL_DATA_BYTES - 4096, JSON.stringify(left))
    assert.ok(left.seconds <= 120 && left.seconds > 110, JSON.stringify(left))
    // An expert-like protocol cannot open a stream; one that opts in, as WebRTC signalling does, can.
    await assert.rejects(conn.newStream('/test/expert/1'), /limited connection/)
    const stream = await conn.newStream('/test/signal/1', { runOnLimitedConnection: true })
    const chunk = new Uint8Array(16 * 1024)
    for (let i = 0; i < 12 && stream.status === 'open' && conn.status === 'open'; i++) {
      if (!stream.send(chunk)) await new Promise((resolve) => stream.addEventListener('drain', resolve, { once: true }))
    }
    await waitFor(
      () => stream.status !== 'open' || conn.status !== 'open',
      () => `received ${received}`,
    )
    assert.ok(received <= SIGNAL_DATA_BYTES, `received ${received}`)
    assert.ok(received > 0, 'bytes went through before the cut')
    // The relay counted no more than it let through.
    assert.ok((await r.live()).counters.relayedBytes <= SIGNAL_DATA_BYTES)
  } finally {
    await stopAll(dialer, target, r)
  }
})

test('relayed bytes are counted in both directions of a stream', async () => {
  const r = await startRelay()
  const target = await peer({ listen: [`${r.ma}/p2p-circuit`] })
  const dialer = await peer()
  try {
    // Echoes what it gets, so bytes flow both ways.
    await target.handle('/test/echo/1', (stream) => stream.addEventListener('message', (e) => stream.send(e.data)), {
      runOnLimitedConnection: true,
    })
    await waitFor(
      () => reserved(target),
      () => 'reservation',
    )
    const conn = await dialer.dial(through(r, target))
    const idle = (await r.live()).counters.relayedBytes
    const stream = await conn.newStream('/test/echo/1', { runOnLimitedConnection: true })
    let back = 0
    stream.addEventListener('message', (e) => (back += e.data.byteLength))
    const size = 8 * 1024
    stream.send(new Uint8Array(size))
    await waitFor(
      () => back >= size,
      () => `echoed ${back}`,
    )
    // There and back again, each direction with its framing on top.
    await waitFor(
      async () => (await r.live()).counters.relayedBytes - idle >= 2 * size,
      async () => `relayed ${(await r.live()).counters.relayedBytes - idle}`,
    )
  } finally {
    await stopAll(dialer, target, r)
  }
})

test('a relay with a throttle admits one identity per address, refuses the next and logs it', async () => {
  const r = await startRelay({ args: ['--new-peers', '1', '--verbose'], env: { REBELLM_TEST_THROTTLE_PRIVATE: '1' } })
  assert.ok(r.lines.includes('new peer identities per address and hour: 1'))
  const lines = r.lines
  const first = await peer()
  const second = await peer()
  try {
    await first.dial(r.ma)
    await waitFor(async () => (await r.live()).connections.open === 1, lines)
    // The handshake completes on the dialer's side before the relay's refusal closes the link.
    await second.dial(r.ma).catch(() => undefined)
    await waitFor(async () => (await r.live()).throttle?.refused === 1, lines)
    await waitFor(() => second.getConnections().length === 0, lines)
    const live = await r.live()
    assert.equal(live.connections.open, 1)
    assert.equal(live.connections.peers, 1)
    const id = second.peerId.toString().slice(-8)
    await waitFor(() => lines.some((l) => new RegExp(`^\\S+ refused ${id} ws new-peers$`).test(l)), lines)
    // The admitted peer dials again freely: a known identity costs nothing.
    await first.hangUp(r.ma)
    await first.dial(r.ma)
    const after = await r.live()
    assert.equal(after.throttle?.refused, 1)
    assert.equal(after.counters.refused, 1)
    assert.deepEqual(after.throttle, { refused: 1, addresses: 1 })
    assert.equal(after.limits.newPeersPerHour, 1)
  } finally {
    await stopAll(second, first, r)
  }
})

test('without a throttle every identity is admitted', async () => {
  const r = await startRelay({ args: ['--new-peers', '0'], env: { REBELLM_TEST_THROTTLE_PRIVATE: '1' } })
  const peers = await Promise.all([peer(), peer(), peer()])
  try {
    assert.ok(r.lines.includes('new peer identities: unlimited'))
    await Promise.all(peers.map((p) => p.dial(r.ma)))
    const live = await r.live()
    assert.equal(live.connections.open, 3)
    assert.equal(live.throttle, null)
    assert.equal(live.limits.newPeersPerHour, 0)
  } finally {
    await stopAll(...peers, r)
  }
})

test('a peer that connects again replaces its dead connection, and gossip reaches it on the new one', async () => {
  const r = await startRelay({ args: ['--verbose'] })
  // Open sockets through this proxy can go silent without closing, as behind a NAT that dropped its mapping.
  const pairs: { live: boolean }[] = []
  const sockets: Socket[] = []
  const proxy = createServer((a) => {
    const b = connect(r.port, '127.0.0.1')
    const pair = { live: true }
    pairs.push(pair)
    sockets.push(a, b)
    for (const [from, to] of [
      [a, b],
      [b, a],
    ]) {
      from.on('data', (d) => pair.live && to.write(d))
      from.on('close', () => pair.live && to.destroy())
      from.on('error', () => undefined)
    }
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve()))
  const addr = proxy.address()
  if (!addr || typeof addr === 'string') throw new Error('proxy not listening')
  const viaProxy = multiaddr(`/ip4/127.0.0.1/tcp/${addr.port}/ws/p2p/${r.peerId}`)
  const client = await peer({ pubsub: true })
  const other = await peer({ pubsub: true })
  const got: number[] = []
  client.services.pubsub.addEventListener('message', () => got.push(1))
  for (const p of [client, other]) p.services.pubsub.subscribe(ANNOUNCE_TOPIC)
  try {
    const dead = await client.dial(viaProxy)
    await other.dial(r.ma)
    await waitFor(async () => (await r.live()).connections.open === 2, r.lines)
    // The path dies silently: the client notices and drops its side, the relay does not.
    for (const p of pairs) p.live = false
    dead.abort(new Error('silent drop'))
    await client.dial(viaProxy)
    // The relay closed the dead connection for the new one: still one per peer.
    await waitFor(
      async () => {
        const live = await r.live()
        return live.connections.open === 2 && live.counters.connectionsOpened === 3
      },
      () => r.live(),
    )
    assert.equal((await r.live()).connections.peers, 2)
    let tries = 0
    await waitFor(() => {
      if (tries++ % 10 === 0)
        other.services.pubsub.publish(ANNOUNCE_TOPIC, announceOf({ served: b64([1]) })).catch(() => undefined)
      return got.length > 0
    }, r.lines)
    // And the other way: the peer knows again that the relay takes announces, and publishes to it.
    const back: number[] = []
    other.services.pubsub.addEventListener('message', () => back.push(1))
    tries = 0
    await waitFor(() => {
      if (tries++ % 10 === 0)
        client.services.pubsub.publish(ANNOUNCE_TOPIC, announceOf({ served: b64([2]) })).catch(() => undefined)
      return back.length > 0
    }, r.lines)
  } finally {
    await stopAll(client, other, r)
    for (const s of sockets) s.destroy()
    await new Promise((resolve) => proxy.close(resolve))
  }
})

test('twenty peers from one address, as behind the proxy, are all admitted at once and all hear announces', async (t) => {
  const N = 20
  const r = await startRelay()
  // Configured like the web app's peer without WebRTC.
  const peers = await Promise.all(Array.from({ length: N }, () => peer({ listen: ['/p2p-circuit'], pubsub: true })))
  /** Receiver id → the ids of the peers whose announce reached it. */
  const heard = new Map<string, Set<string>>(peers.map((p) => [p.peerId.toString(), new Set<string>()]))
  for (const p of peers) {
    p.services.pubsub.subscribe(ANNOUNCE_TOPIC)
    p.services.pubsub.addEventListener('message', (e) => heard.get(p.peerId.toString())!.add(e.detail.from.toString()))
  }
  const gossip = async () => (await r.live()).gossip.announce
  const reservations = async () => (await r.live()).reservations
  try {
    const dials = await Promise.allSettled(peers.map((p) => p.dial(r.ma)))
    const refused = dials.filter((d) => d.status === 'rejected').length
    t.diagnostic(`first dials refused: ${refused} of ${N}`)
    assert.equal(refused, 0, `${refused} of ${N} first dials refused`)
    await waitFor(
      async () => (await gossip()).subscribers === N,
      async () => `subscribers ${(await gossip()).subscribers}`,
    )
    // Forwarding goes to the relay's mesh; publishing before it forms would test IHAVE gossip only.
    await waitFor(
      async () => (await gossip()).mesh >= 6,
      async () => `mesh ${(await gossip()).mesh}`,
    )
    const publish = () =>
      Promise.all(peers.map((p, i) => p.services.pubsub.publish(ANNOUNCE_TOPIC, announceOf({ served: b64([i]) }))))
    await publish()
    const reached = () => [...heard.values()].filter((from) => from.size > 0).length
    // A peer outside the relay's mesh hears of a message by IHAVE gossip, which each heartbeat
    // goes to a random part of them: nodes announce again and again, and so does this test.
    let polls = 0
    await waitFor(
      () => {
        if (++polls % 60 === 0) publish().catch(() => undefined)
        return reached() === N
      },
      async () => `peers reached ${reached()} of ${N}; relay mesh ${(await gossip()).mesh}`,
      15_000,
    )
    // IHAVE gossip covers peers outside the relay's mesh over three heartbeats.
    await sleep(3000)
    const deliveries = [...heard.values()].reduce((s, from) => s + from.size, 0)
    t.diagnostic(
      `peers reached ${reached()} of ${N}; deliveries ${deliveries} of ${N * (N - 1)}; relay mesh ${(await gossip()).mesh}`,
    )
    await waitFor(
      async () => (await reservations()) === N,
      async () => `reservations ${await reservations()}`,
    )
    const live = await r.live()
    assert.equal(live.counters.announcesAccepted >= N, true, JSON.stringify(live.counters))
    assert.equal(live.counters.announcesRejected, 0)
    await Promise.all(peers.map((p) => p.stop()))
    // Every peer left: its slot goes with its last connection, not with the TTL.
    await waitFor(
      async () => (await r.live()).connections.open === 0,
      async () => `connections ${(await r.live()).connections.open}`,
    )
    t.diagnostic(`reservations after the peers left: ${await reservations()}`)
    assert.equal(await reservations(), 0)
  } finally {
    await stopAll(...peers, r)
  }
})

test('the relay takes a proxy: 100 dials a second, 256 handshakes, 1000 connections and reservations of 30 minutes', async () => {
  const r = await startRelay()
  try {
    assert.deepEqual((await r.live()).limits, {
      connections: 1000,
      acceptPerSecond: 100,
      pending: 256,
      reservations: 1000,
      reservationTtlMs: 30 * 60_000,
      newPeersPerHour: 5,
    })
  } finally {
    await r.stop()
  }
})

test('undecodable announces are not forwarded, and the relay counts them', async () => {
  const r = await startRelay()
  const client = await peer({ pubsub: true })
  const listener = await peer({ pubsub: true })
  const heard: string[] = []
  listener.services.pubsub.addEventListener('message', (e) => heard.push(new TextDecoder().decode(e.detail.data)))
  for (const p of [client, listener]) p.services.pubsub.subscribe(ANNOUNCE_TOPIC)
  try {
    await client.dial(r.ma)
    await listener.dial(r.ma)
    await waitFor(async () => (await r.live()).gossip.announce.subscribers === 2, r.lines)
    let tries = 0
    await waitFor(async () => {
      // A new message each time: gossip drops one it has seen.
      if (tries++ % 10 === 0)
        client.services.pubsub.publish(ANNOUNCE_TOPIC, enc({ v: 2, junk: tries })).catch(() => undefined)
      return (await r.live()).counters.announcesRejected > 0
    }, r.lines)
    tries = 0
    await waitFor(() => {
      if (tries++ % 10 === 0)
        client.services.pubsub.publish(ANNOUNCE_TOPIC, announceOf({ n: tries })).catch(() => undefined)
      return heard.length > 0
    }, r.lines)
    assert.ok(
      heard.every((h) => JSON.parse(h).v === 1),
      heard.join('\n'),
    )
  } finally {
    await stopAll(client, listener, r)
  }
})

test('a peer that never answers pings is dropped after the silence; one that answers stays', async () => {
  const r = await startRelay({ env: { REBELLM_TEST_PEER_PING_MS: '100', REBELLM_TEST_PEER_SILENT_MS: '500' } })
  const mute = await peer()
  // Holds the ping stream open and never answers, as a page whose thread is busy.
  await mute.handle('/ipfs/ping/1.0.0', () => new Promise(() => undefined))
  const live = await peer({ services: { ping: ping() } })
  try {
    // rust-libp2p sends its first ping when the connection opens, js-libp2p 100 ms later: the
    // silence is measured from before the dial.
    const t0 = Date.now()
    await mute.dial(r.ma)
    await live.dial(r.ma)
    await waitFor(async () => (await r.live()).connections.open === 1, r.lines, 3000)
    // The ping's answer is waited for 500 ms.
    assert.ok(Date.now() - t0 >= 500, `dropped after ${Date.now() - t0} ms`)
    assert.equal(mute.getConnections().length, 0)
    // The one that answers is still there several pings later.
    await sleep(700)
    assert.equal((await r.live()).connections.open, 1)
    assert.equal(live.getConnections().length, 1)
  } finally {
    await stopAll(mute, live, r)
  }
})

test('a peer without the ping protocol is not taken for a silent one', async () => {
  const r = await startRelay({ env: { REBELLM_TEST_PEER_PING_MS: '100', REBELLM_TEST_PEER_SILENT_MS: '300' } })
  const plain = await peer()
  try {
    await plain.dial(r.ma)
    await sleep(1000)
    assert.equal((await r.live()).connections.open, 1)
  } finally {
    await stopAll(plain, r)
  }
})

test('the last close frees the reservation; a replaced connection keeps it', async () => {
  const r = await startRelay()
  const client = await peer({ listen: [`${r.ma}/p2p-circuit`] })
  const other = await peer()
  try {
    await waitFor(async () => (await r.live()).reservations === 1, r.lines)
    // A second connection of the same peer: the relay closes the older one, the slot stays.
    await client.dial(r.ma, { force: true })
    await waitFor(
      async () => {
        const live = await r.live()
        return live.counters.connectionsOpened === 2 && live.connections.open === 1
      },
      () => r.live(),
    )
    assert.equal((await r.live()).reservations, 1)
    // The peer is still reached through the relay, over the connection that is left.
    await other.dial(through(r, client))
    await client.stop()
    await waitFor(
      async () => (await r.live()).reservations === 0,
      () => r.live(),
    )
  } finally {
    await stopAll(other, client, r)
  }
})

test('a peer back after its reservation was freed keeps the new one past the old one’s TTL', async () => {
  const TTL = 4000
  const r = await startRelay({ env: { REBELLM_TEST_RESERVATION_TTL_MS: String(TTL) } })
  const privateKey = await generateKeyPair('Ed25519')
  const client = () => peer({ privateKey, listen: ['/p2p-circuit'] })
  const reservations = async () => (await r.live()).reservations
  const clients: Awaited<ReturnType<typeof client>>[] = []
  const other = await peer()
  try {
    const first = await client()
    clients.push(first)
    const t0 = Date.now()
    await first.dial(r.ma)
    await waitFor(async () => (await reservations()) === 1, ['first reservation'])
    await first.stop()
    await waitFor(async () => (await reservations()) === 0, ['freed on close'])
    await sleep(t0 + TTL / 2 - Date.now())
    const again = await client()
    clients.push(again)
    await again.dial(r.ma)
    await waitFor(async () => (await reservations()) === 1, ['second reservation'])
    // Past the first reservation's timer, before the second one's.
    await sleep(t0 + TTL + 700 - Date.now())
    assert.equal(await reservations(), 1, 'the freed reservation’s timer removed the new one')
    // Not expired: the peer is reached through it.
    await other.dial(through(r, again))
  } finally {
    await stopAll(other, ...clients, r)
  }
})

test('the peer id tool prints the id the relay runs with, also for a key js-libp2p wrote', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-id-'))
  try {
    const key = join(dir, 'k.bin')
    const r = await startRelay({ key, admin: false })
    await r.stop()
    const out = spawnSync(PEER_ID_BIN, [key], { encoding: 'utf8' })
    assert.equal(out.stdout.trim(), r.peerId)
    // The key file of the Node.js relay: the same bytes give the same identity.
    const privateKey = await generateKeyPair('Ed25519')
    const old = join(dir, 'node.bin')
    await writeFile(old, privateKeyToProtobuf(privateKey))
    const id = peerIdFromPrivateKey(privateKey).toString()
    assert.equal(spawnSync(PEER_ID_BIN, [old], { encoding: 'utf8' }).stdout.trim(), id)
    const moved = await startRelay({ key: old, admin: false })
    await moved.stop()
    assert.equal(moved.peerId, id)
    // And the key the relay wrote reads back in js-libp2p.
    const { privateKeyFromProtobuf } = await import('@libp2p/crypto/keys')
    assert.equal(peerIdFromPrivateKey(privateKeyFromProtobuf(await readFile(key))).toString(), r.peerId)
    const missing = spawnSync(PEER_ID_BIN, [join(dir, 'none.bin')], { encoding: 'utf8' })
    assert.notEqual(missing.status, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/** The daily files of `kind` in `dir`. */
const daily = async (dir: string, kind: string) =>
  (await readdir(dir))
    .filter((f) => new RegExp(`^${kind}-\\d{4}-\\d{2}-\\d{2}\\.csv$`).test(f))
    .map((f) => join(dir, f))

/** No file of the statistics directory contains the peer id; a temp file renamed meanwhile is read under its name. */
async function noFileHolds(dir: string, id: string) {
  for (const f of await readdir(dir)) {
    const text = await readFile(join(dir, f), 'utf8').catch((e) => {
      if (e.code === 'ENOENT' && f.endsWith('.tmp')) return ''
      throw e
    })
    assert.ok(!text.includes(id), f)
  }
}

test('a real relay with a stats file keeps an announcing peer, counts relayed bytes and writes the files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-stats-real-'))
  const file = join(dir, 'peers.csv')
  // One tick, late enough for everything below to happen within its window.
  const r = await startRelay({ stats: file, env: { REBELLM_TEST_STATS_INTERVAL_MS: '9000' } })
  const client = await peer({ listen: [`${r.ma}/p2p-circuit`], pubsub: true })
  const other = await peer()
  try {
    assert.ok(
      r.lines.some((l) =>
        l.startsWith('statistics every 5 min to peers-, hot-, reports- and counts-<UTC day>.csv in '),
      ),
    )
    const id = client.peerId.toString()
    client.services.pubsub.subscribe(ANNOUNCE_TOPIC)
    const announce = announceOf({ vramBytes: 8e9, app: 'x' })
    let tries = 0
    await waitFor(async () => {
      if (tries++ % 10 === 0) client.services.pubsub.publish(ANNOUNCE_TOPIC, announce).catch(() => undefined)
      return (await r.live()).peers?.rows.some((row) => row.peer === id)
    }, r.lines)
    await waitFor(() => reserved(client), [])
    await other.dial(through(r, client))
    await waitFor(async () => ((await r.live()).peers?.relayedBytes ?? 0) > 0, r.lines)
    await waitFor(async () => (await daily(dir, 'peers')).length > 0, r.lines)
    const [peersFile, ...more] = await daily(dir, 'peers')
    assert.deepEqual(more, [])
    const [header, total, network, end] = (await readFile(peersFile, 'utf8')).split('\n')
    assert.equal(header, PEERS_HEADER)
    // The announcing peer reserved the slot the other dialled through; its id is in no file.
    assert.match(total, new RegExp(`,total,,,,,8000000000,0,0,2,1,,0,[1-9]\\d*,${E8},0$`))
    await waitFor(async () => (await daily(dir, 'counts')).length > 0, r.lines)
    const [counts] = await daily(dir, 'counts')
    const countLines = (await readFile(counts, 'utf8')).split('\n')
    assert.ok(countLines.includes(`${total.slice(0, 24)},nodes,all,,1`))
    await noFileHolds(dir, id)
    // Two WebSocket connections; experts 0 and 2 of 8 have one replica; bytes went through; a
    // measured lag; the process memory, the client's reservation and subscription, both
    // connections, the relayed stream, no refusal and no token.
    assert.match(network, /,network,2,2,0,\d+,0,0,1,6,[1-9]\d*,,,,\d+,[1-9]\d*,[1-9]\d*,1,1,[2-9]\d*,[1-9]\d*,0,0,$/)
    assert.equal(end, '')
    assert.equal(await readFile((await daily(dir, 'hot'))[0], 'utf8'), `${HOT_HEADER}\n`)
    // The counters and the live snapshot.
    const live = await r.live()
    const c = live.counters
    assert.ok(c.connectionsOpened >= 2 && c.reservationsGranted >= 1 && c.announcesAccepted >= 1, JSON.stringify(c))
    assert.ok(c.relayedStreams >= 1 && c.relayedBytes > 0, JSON.stringify(c))
    assert.equal(live.peerId, r.peerId)
    assert.equal(live.statistics, true)
    assert.equal(live.modelTokens, false)
    assert.equal(live.connections.open, 2)
    assert.equal(live.connections.peers, 2)
    assert.equal(live.connections.byTransport.ws, 2)
    assert.equal(live.reservations, 1)
    assert.equal(live.gossip.announce.subscribers, 1)
    assert.equal(live.gossip.peers, 1)
    assert.ok(live.process.rssBytes! > 0 && live.process.cpuUserUs! > 0 && live.process.loopLagMs! >= 0)
    assert.ok(live.process.heapUsedBytes! > 0)
    assert.equal(live.peers!.count, 1)
    assert.equal(live.peers!.rows[0].peer, id)
    assert.equal(live.peers!.rows[0].vramBytes, 8e9)
    assert.deepEqual(live.peers!.replicas, { min: 0, median: 0, max: 1, none: 6 })
    assert.equal(live.limits.connections, 1000)
  } finally {
    await stopAll(client, other, r)
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
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

test('a real relay with a stats file writes a published report and passes it to nobody', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-reports-real-'))
  const file = join(dir, 'peers.csv')
  const r = await startRelay({ stats: file, env: { REBELLM_TEST_STATS_INTERVAL_MS: '6000' } })
  const client = await peer({ pubsub: true })
  const listener = await peer({ pubsub: true })
  const heard: string[] = []
  listener.services.pubsub.addEventListener('message', (e) => heard.push(e.detail.topic))
  // A peer that asks for reports: it gets the announces through the relay, never a report.
  for (const topic of [ANNOUNCE_TOPIC, REPORT_TOPIC]) listener.services.pubsub.subscribe(topic)
  client.services.pubsub.subscribe(ANNOUNCE_TOPIC)
  try {
    await client.dial(r.ma)
    await listener.dial(r.ma)
    const id = client.peerId.toString()
    let tries = 0
    await waitFor(() => {
      if (tries++ % 10 === 0)
        client.services.pubsub.publish(ANNOUNCE_TOPIC, announceOf({ n: tries })).catch(() => undefined)
      return heard.includes(ANNOUNCE_TOPIC)
    }, r.lines)
    tries = 0
    await waitFor(async () => {
      if (tries++ % 10 === 0) client.services.pubsub.publish(REPORT_TOPIC, enc(usageReport())).catch(() => undefined)
      return (await r.live()).counters.reportsAccepted > 0
    }, r.lines)
    await sleep(1500)
    assert.ok(!heard.includes(REPORT_TOPIC), heard.join(','))
    const live = await r.live()
    assert.ok(live.counters.reportsAccepted >= 1, JSON.stringify(live.counters))
    assert.equal(live.counters.reportsRejected, 0)
    assert.equal(live.gossip.report.subscribers, 1)
    await waitFor(async () => (await daily(dir, 'reports')).length > 0, r.lines)
    const [reports] = await daily(dir, 'reports')
    await waitFor(async () => (await readFile(reports, 'utf8')).split('\n').length > 2, r.lines)
    const [header, row] = (await readFile(reports, 'utf8')).split('\n')
    assert.equal(
      header,
      'time,app,gpu,precision,vram_bytes,budget_bytes,phone,browser,os,' +
        'requests,tokens,prefill_tok_per_sec,decode_tok_per_sec,misses_per_token,lookahead_rate,' +
        'remote_p50_ms,remote_p95_ms,wait_ms_per_token,context_p50,stops_eos,stops_length,stops_loop,stops_abort,' +
        'tool_calls,load_ms,loaded_from_storage,failures_oom,failures_wasm,failures_unavailable,failures_other,parks,' +
        'node_calls,node_call_p50_ms,node_errors,node_checks_passed,node_checks_failed,node_marked_down,' +
        'node_expert_load_p50_ms,net_up_per_token,net_down_per_token',
    )
    assert.equal(row, `${row.slice(0, 24)},${REPORT_CELLS}`)
    await noFileHolds(dir, id)
  } finally {
    await stopAll(client, listener, r)
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('a report over 2 KB is rejected for gossip', async () => {
  const r = await startRelay()
  const client = await peer({ pubsub: true })
  try {
    await client.dial(r.ma)
    await waitFor(async () => (await r.live()).gossip.peers === 1, r.lines)
    let tries = 0
    await waitFor(async () => {
      if (tries++ % 10 === 0)
        client.services.pubsub
          .publish(REPORT_TOPIC, enc(usageReport({ pad: 'x'.repeat(5 * 1024), n: tries })))
          .catch(() => undefined)
      return (await r.live()).counters.reportsRejected > 0
    }, r.lines)
    assert.equal((await r.live()).counters.reportsAccepted, 0)
  } finally {
    await stopAll(client, r)
  }
})
