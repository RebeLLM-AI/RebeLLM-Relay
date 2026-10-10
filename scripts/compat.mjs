// Builds the relay and runs the black-box suite against it: js-libp2p peers of the web app's
// versions, the sidecar started by the relay as in production.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const run = (cmd, args, o = {}) => spawnSync(cmd, args, { stdio: 'inherit', ...o })

const build = run('cargo', ['build', '--bins'])
if (build.status !== 0) process.exit(build.status ?? 1)

const meta = spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], {
  encoding: 'utf8',
  maxBuffer: 64 * 2 ** 20,
})
if (meta.status !== 0) {
  process.stderr.write(meta.stderr ?? '')
  process.exit(meta.status ?? 1)
}
const exe = process.platform === 'win32' ? '.exe' : ''
const dir = join(JSON.parse(meta.stdout).target_directory, 'debug')
const tests = readdirSync('compat')
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => join('compat', f))
// One file at a time: each test starts relays and a score of libp2p nodes.
const r = run(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2), ...tests], {
  env: {
    ...process.env,
    REBELLM_RELAY_BIN: join(dir, `rebellm-relay${exe}`),
    REBELLM_PEER_ID_BIN: join(dir, `rebellm-relay-peer-id${exe}`),
  },
})
process.exit(r.status ?? 1)
