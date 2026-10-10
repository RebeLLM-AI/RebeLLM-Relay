// Runs a binary in this process's place, as far as Node.js can: same arguments and standard
// streams, SIGINT and SIGTERM passed on, and its exit code as this process's.
import { spawn } from 'node:child_process'

export function run(bin: string, args: string[] = process.argv.slice(2)) {
  const child = spawn(bin, args, { stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
  child.on('error', (e) => {
    console.error(`${bin}: ${e.message}`)
    process.exit(127)
  })
  // Ended by a signal it did not handle: not a clean exit.
  child.on('exit', (code) => process.exit(code ?? 1))
}
