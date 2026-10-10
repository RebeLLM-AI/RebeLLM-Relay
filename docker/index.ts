#!/usr/bin/env node
// `node index.ts <options>`, the start command of the previous relay image: runs the relay.
import { run } from './run.ts'

run(process.env.REBELLM_RELAY_BIN || 'rebellm-relay')
