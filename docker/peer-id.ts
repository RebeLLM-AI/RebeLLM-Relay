#!/usr/bin/env node
// `node peer-id.ts <key file>`, as the previous relay image answered it: prints the peer id.
import { run } from './run.ts'

run(process.env.REBELLM_PEER_ID_BIN || 'rebellm-relay-peer-id')
