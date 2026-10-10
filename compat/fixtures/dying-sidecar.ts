// A sidecar that dies once: the first start exits two seconds after it began to serve, every
// later one is the real sidecar. The mark file remembers that the first start happened.
import { existsSync, writeFileSync } from 'node:fs'

const mark = process.env.DYING_SIDECAR_MARK ?? ''
if (mark && !existsSync(mark)) {
  writeFileSync(mark, 'died')
  setTimeout(() => process.exit(3), 2000)
}
await import('../../sidecar/index.ts')
