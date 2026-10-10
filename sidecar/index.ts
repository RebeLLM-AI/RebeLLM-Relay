#!/usr/bin/env node
// The relay's statistics sidecar: started by the relay, it reads the relay's lines on its
// standard input, keeps the statistics files and the VRAM history, and serves them with the
// admin API on the stats port. Its standard output is the line protocol; it ends when its
// input closes.
import { createServer, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { createAdminHandler } from './admin.ts'
import { Bridge, liveOf, type Options } from './bridge.ts'
import { Buckets, createHistoryHandler, loadHistory } from './history.ts'
import { HISTORY_FILE, watchStats } from './stats.ts'

const send = (line: unknown) => process.stdout.write(`${JSON.stringify(line)}\n`)
const log = (line: string) => send({ t: 'log', line })
const err = (line: string) => send({ t: 'err', line })

const bridge = new Bridge(send)
let server: Server | undefined
let watched: ReturnType<typeof watchStats> | undefined

async function start(opt: Options) {
  const stats = opt.stats || undefined
  const host = opt.host || '0.0.0.0'
  // An unreadable file costs the history before this start, not the statistics.
  const history = stats
    ? await loadHistory(join(dirname(stats), HISTORY_FILE), stats, { warn: err }).catch((e) => {
        err(`VRAM history not rebuilt from ${stats}: ${e.message}`)
        return new Buckets()
      })
    : undefined
  if (stats) {
    watched = watchStats(bridge, {
      file: stats,
      history,
      intervalMs: opt.intervalMs || undefined,
      log,
      onError: (e) => err(`${new Date().toISOString()} stats not written: ${e.message}`),
    })
    // Accepted by the relay's validator; the peer id stays in memory, for the day's reporters.
    bridge.addEventListener('report', (e) => {
      const { peer, data } = (e as CustomEvent<{ peer: string; data: Uint8Array }>).detail
      watched?.stats.recordReport(peer, data)
    })
  }
  const admin = opt.adminKey
    ? createAdminHandler({
        key: opt.adminKey,
        live: liveOf(bridge, () => watched?.stats.live()),
        history: () => history,
        dir: stats ? dirname(stats) : undefined,
      })
    : undefined
  if (opt.statsPort && (history || admin)) {
    const historyHandler = createHistoryHandler(() => history)
    server = createServer((req, res) =>
      admin ? admin(req, res, () => historyHandler(req, res)) : historyHandler(req, res),
    )
    server.on('error', (e) => err(`VRAM history and admin API not served: ${e.message}`))
    server.listen(opt.statsPort, host, () => {
      if (history) log(`VRAM history on ${host}:${opt.statsPort}/stats/history`)
      if (admin) log(`admin API on ${host}:${opt.statsPort}/admin/api/`)
    })
  }
}

let started: Promise<void> | undefined
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  bridge.receive(m)
  // The first hello carries the options; a later one only resets the connections.
  if (m?.t === 'hello' && !started)
    started = start(bridge.options ?? {}).catch((e) => {
      err(`statistics sidecar not started: ${e.message}`)
      process.exitCode = 1
      lines.close()
    })
})
// The relay is gone, or stopping: finish the write in flight and end with it.
lines.on('close', async () => {
  server?.close()
  server?.closeAllConnections()
  watched?.stop()
  await started?.catch(() => undefined)
  await watched?.stats.pending.catch(() => undefined)
  process.exit()
})
