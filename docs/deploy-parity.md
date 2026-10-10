# Replacing the Node.js relay

What stays the same for whoever runs the relay, and what the application repository (the web
app, its dev servers and its deployment) has to change before its own `relay/` directory can
be deleted.

## The same

| | |
| --- | --- |
| Command line | every flag, default, environment variable and error message |
| Console | the start lines, the bootstrap addresses, the status line, the verbose lines |
| Ports | 9090 libp2p over WebSocket, 9091 fetch proxy, 9092 history and admin API |
| Key file | libp2p protobuf private key; a key written by the Node.js relay gives the same peer id |
| Statistics | file names, headers, rows, retention, migration, `history.json`; an existing directory is read as it is |
| HTTP | `/fetch`, `/stats/history`, `/admin/api/live`, `/admin/api/history`, with the same statuses, headers and JSON |
| Admin key | `scrypt.<salt>.<hash>` as the deployment derives it |
| Model file tokens | `/rebellm/model-access/1.0.0`, one JSON line, nginx `secure_link_md5` signature |
| Protocols | WebSocket, Noise, Yamux, identify, ping, circuit relay v2 (2 min, 128 KiB), gossipsub 1.2 |
| Image | user `node`, working directory `/app`, volume `/data`, and the commands `node index.ts ...` and `node peer-id.ts <key file>` |

## Different, on purpose

- **Two processes.** The relay starts `node sidecar/index.ts` for the statistics and the
  stats port. A container's memory limit covers both.
- **`/admin/api/live`, `process`.** The figures are the Rust process's: `heapUsedBytes` is
  the bytes allocated, `heapTotalBytes` their peak, `externalBytes` and `arrayBuffersBytes`
  are 0, `loopLagMs` is the lateness of a 20 ms timer on the relay's runtime. The statistics'
  `heap_bytes` and `loop_lag_ms` columns follow.
- **Without the sidecar** (it cannot start, or between a crash and its restart) the stats
  port does not answer; the relay keeps serving peers.
- **`--stats-port` without `--stats` or `--admin-key`** opens nothing, as before; with
  neither, no sidecar runs at all.
- **No JavaScript API.** The Node.js relay could be imported and started with
  `startRelay()`, and its fetch, history and admin handlers mounted in another server. The
  Rust relay is a program: a host starts the binary.

## What the application repository has to change

### Deployment

1. **Build context.** `compose.yaml` builds the relay from `../relay`. Point it at a checkout
   of this repository (or at an image built from it). The service's `command`
   (`node index.ts --port 9090 --key /data/relay-key.bin --announce ...`), environment,
   volume, read-only root file system and limits can stay; `rebellm-relay --port ...` is the
   direct form.
2. **Uploaded files.** The deploy script uploads a fixed list of `relay/*.ts` files and
   hashes them to decide whether the relay restarts. The list becomes this repository's
   build inputs: `Dockerfile`, `.dockerignore`, `Cargo.toml`, `Cargo.lock`, `rustfmt.toml`,
   `src/`, `vendor/`, `sidecar/` (without tests) and `docker/`. Its tests that compare the
   list with the directory need the same change.
3. **First build.** The image compiles the relay in release mode on the server: several
   minutes and about 2 GB of memory once, cached by Docker afterwards. Building the image
   elsewhere and pulling it avoids that.
4. **Peer id.** `docker compose exec -T rebellm-relay node peer-id.ts /data/relay-key.bin`
   works as it is; `rebellm-relay-peer-id /data/relay-key.bin` is the direct form. The start
   line `relay <id> listening on ...`, which the script falls back to, is unchanged.
5. **Admin key.** The deploy script imports `adminKey` from `relay/admin.ts`. The same
   function is in `sidecar/admin.ts` here; the script needs it from there, or its own copy
   (twenty lines on Node's scrypt).
6. **Memory limit.** 2 GB covers the relay and the sidecar with room to spare; nothing to do.

### Web app, dev servers and end-to-end tests

7. **Dev and preview servers** host a relay in-process (`startRelay` from `relay/lib.ts`) and
   mount `createFetchHandler`, `createHistoryHandler` and `createAdminHandler`. They have to
   start the `rebellm-relay` binary instead and proxy `/fetch`, `/stats/history` and
   `/admin/api/` to its ports.
8. **Model file server of the dev server** imports `checkModelToken`, `needsToken` and
   `tokenCookies` from `relay/token.ts`. They are Rust here (`src/token.rs`); the dev server
   needs its own copy of those three small functions.
9. **End-to-end scripts** start `relay/index.ts` as a child process and import headers and
   helpers (`PEERS_HEADER`, `REPORTS_HEADER`, `COUNTS_HEADER`, `HOT_HEADER`, `budgetBucket`,
   `countRows`, `dailyFile`, `dailyFiles`, `PEERS_COLUMNS`, `REPORTS_COLUMNS`, `adminKey`).
   The binary replaces the child process; the helpers are in `sidecar/stats.ts`,
   `sidecar/daily.ts` and `sidecar/admin.ts`.
10. **Tooling.** The root `typecheck`, `test` and `postinstall` scripts, the ESLint
    configuration and `.gitignore` name `relay/`; those entries go with the directory.
11. **Specs.** The relay requirements of the application repository's `p2p-transport`,
    `model-file-access` and `deployment` specs are this repository's specs now
    (`openspec/specs/`); there they shrink to what the web app and the deployment do. The
    requirement that the relay image runs the TypeScript sources no longer holds.

## Before the old relay goes

- Build the image once and run it against a copy of the production `/data` volume: the key
  gives the same peer id, the statistics directory is read, `/stats/history` shows the past.
  This repository's checks do not build the image.
- Run the application repository's browser end-to-end tests against the binary. The
  black-box suite here drives the relay with js-libp2p in Node.js, without WebRTC; a browser
  run covers WebRTC signalling through the circuit and the WebSocket implementation of real
  browsers.
