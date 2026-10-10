// The image's files: the commands of the previous relay image run the Rust binaries, and the
// Dockerfile copies what the relay needs and nothing of the tests.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { PEER_ID_BIN, RELAY_BIN, freePort, waitFor } from './harness.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const shim = (name: string) => join(root, 'docker', name)
const env = { ...process.env, REBELLM_RELAY_BIN: RELAY_BIN, REBELLM_PEER_ID_BIN: PEER_ID_BIN }
const node = (args: string[]) => spawnSync(process.execPath, args, { encoding: 'utf8', env })

test('node index.ts runs the relay with its arguments and ends with its exit code', () => {
  const help = node([shim('index.ts'), '--help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /^rebellm-relay \[--port 9090\]/)
  assert.match(help.stdout, /--admin-key/)
  const bad = node([shim('index.ts'), '--port', '70000'])
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr, /invalid port 70000/)
})

test('a missing binary is said so and ends with 127', () => {
  const r = spawnSync(process.execPath, [shim('index.ts'), '--help'], {
    encoding: 'utf8',
    env: { ...process.env, REBELLM_RELAY_BIN: 'rebellm-no-such-relay-binary' },
  })
  assert.equal(r.status, 127)
  assert.match(r.stderr, /rebellm-no-such-relay-binary/)
})

test('the compose command of the previous relay starts the relay; node peer-id.ts prints its id; SIGTERM stops it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-image-'))
  const key = join(dir, 'relay-key.bin')
  const port = await freePort()
  const args = ['--host', '127.0.0.1', '--port', String(port), '--key', key]
  const child = spawn(
    process.execPath,
    [shim('index.ts'), ...args, '--announce', '/dns4/relay.example.org/tcp/443/wss'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const lines: string[] = []
  const take = (d: Buffer) => lines.push(...d.toString().split(/\r?\n/))
  child.stdout.on('data', take)
  child.stderr.on('data', take)
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
  try {
    await waitFor(() => lines.some((l) => l.startsWith('model file tokens:')), lines, 60_000)
    const started = lines.find((l) => /^relay \S+ listening on 127\.0\.0\.1:/.test(l)) ?? ''
    const id = started.split(' ')[1]
    assert.ok(lines.includes(`  /dns4/relay.example.org/tcp/443/wss/p2p/${id}`), lines.join('\n'))
    const printed = node([shim('peer-id.ts'), key])
    assert.equal(printed.status, 0)
    assert.equal(printed.stdout.trim(), id)
    assert.notEqual(node([shim('peer-id.ts'), join(dir, 'none.bin')]).status, 0)
  } finally {
    // Windows has no SIGTERM to pass on: there the test ends the shim and the relay it started.
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'])
    else child.kill('SIGTERM')
    const code = await exited
    if (process.platform !== 'win32') assert.equal(code, 0, 'the relay stopped cleanly and the shim passed its code on')
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('the Dockerfile copies the binaries, the old commands and every sidecar module, and no test', async () => {
  const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8')
  const ignore = (await readFile(join(root, '.dockerignore'), 'utf8')).split(/\r?\n/)
  assert.match(dockerfile, /COPY --from=build \S+\/rebellm-relay \S+\/rebellm-relay-peer-id \/usr\/local\/bin\//)
  // Every file a shim needs is copied next to it.
  for (const f of await readdir(join(root, 'docker'))) assert.ok(dockerfile.includes(`docker/${f}`), f)
  // The sidecar goes in whole; the tests are kept out by .dockerignore.
  assert.match(dockerfile, /^COPY sidecar\/ \.\/sidecar\/$/m)
  assert.ok(ignore.includes('**/*.test.ts'))
  assert.match(dockerfile, /^ENV REBELLM_SIDECAR=\/app\/sidecar\/index\.ts$/m)
  // What the build stage compiles is not ignored away.
  for (const needed of ['src', 'vendor', 'sidecar', 'docker', 'Cargo.toml', 'Cargo.lock'])
    assert.ok(!ignore.includes(needed), needed)
  // As the previous image: unprivileged, the data in a volume, the three ports, port 9090 by default.
  assert.match(dockerfile, /^WORKDIR \/app$/m)
  assert.match(dockerfile, /^USER node$/m)
  assert.match(dockerfile, /^VOLUME \/data$/m)
  assert.match(dockerfile, /^EXPOSE 9090 9091 9092$/m)
  assert.match(dockerfile, /^CMD \["rebellm-relay", "--port", "9090", "--key", "\/data\/relay-key\.bin"\]$/m)
})
