# RebeLLM relay

The relay of the [RebeLLM](https://rebellm.ai) network: the one server browser peers need
to find each other. It carries no model traffic.

- **Bootstrap.** Browsers connect over WebSocket (libp2p, Noise, Yamux), usually through a
  TLS-terminating reverse proxy.
- **WebRTC signalling.** Circuit relay v2, limited to 2 minutes and 128 KiB per relayed
  connection: enough for offers, answers and candidates, nothing else.
- **Announce gossip.** Gossipsub on `rebellm/announce/1`; announces a browser would not decode
  are not forwarded. Usage reports on `rebellm/report/1` are recorded and forwarded to nobody.
- **Admission.** At most 5 new peer identities per public address and hour, 1 000
  connections, 100 new connections per second from one host.
- **Model file tokens.** With `--models-secret`, connected peers get a one-hour token on
  `/rebellm/model-access/1.0.0` that a file server checks (nginx `secure_link_md5`).
- **Page-fetch proxy.** Optional `GET /fetch?url=` for private networks, public addresses only.
- **Statistics and admin API.** Daily CSV files without peer identifiers, the network's
  memory history and an admin API, kept by a Node.js sidecar the relay starts.

The relay is written in Rust on [rust-libp2p](https://github.com/libp2p/rust-libp2p) and
serves browsers running [js-libp2p](https://github.com/libp2p/js-libp2p). It replaces a
Node.js relay and keeps that relay's command line, console output, key file, statistics files
and HTTP answers.

## Build

Rust (stable, 1.85 or newer) and Node.js 22.18 or newer.

```sh
npm install              # tooling, the black-box suite's peers, the pre-commit hook
cargo build --release    # target/release/rebellm-relay and rebellm-relay-peer-id
```

## Run

```sh
rebellm-relay --port 9090 --key relay-key.bin --announce /dns4/relay.example.org/tcp/443/wss
```

It prints `relay <peer id> listening on <host>:<port>` and the bootstrap addresses to give
to peers. `rebellm-relay-peer-id <key file>` prints the peer id of a key file without
starting a relay.

| Option | Environment | Default | |
| --- | --- | --- | --- |
| `--port` | | 9090 | libp2p over WebSocket |
| `--host` | | 0.0.0.0 | address to bind, also for the HTTP ports |
| `--key` | | `relay-key.bin` | identity file, created on first run |
| `--announce` | | | public multiaddr to advertise; repeatable |
| `--verbose` | `REBELLM_RELAY_VERBOSE=1` | off | a line per connection, announce, reservation, relayed stream |
| `--new-peers` | `REBELLM_NEW_PEERS` | 5 | new identities per address and hour; 0 turns it off |
| `--models-secret` | `REBELLM_MODELS_SECRET` | | secret of the model file tokens |
| `--fetch-port` | `REBELLM_FETCH_PORT` | off | port of the page-fetch proxy |
| `--stats` | `REBELLM_RELAY_STATS` | | base path of the statistics files |
| `--stats-port` | `REBELLM_STATS_PORT` | 9092 with `--stats` or `--admin-key` | `/stats/history` and the admin API; 0 turns it off |
| `--admin-key` | `REBELLM_ADMIN_KEY` | | `scrypt.<salt>.<hash>` of the admin login |
| `--help` | | | the usage |

A flag wins over its environment variable.

## The sidecar

With `--stats`, or with `--admin-key` and a stats port, the relay starts
`node sidecar/index.ts` as a child process. The sidecar writes `peers-`, `hot-`, `reports-`
and `counts-<UTC day>.csv` and `history.json` beside the `--stats` path, deletes days older
than 12 months, and serves the stats port:

- `GET /stats/history[?days=N]` — the network's expert memory in 6-hour buckets;
- `GET /admin/api/live`, `GET /admin/api/history[?days=N]` — behind the admin login.

Relay and sidecar exchange JSON lines over the sidecar's standard streams. The relay serves
peers whether or not the sidecar runs: if it cannot be started or exits, the relay says so and
starts it again after 1 s, doubling up to 60 s. The sidecar exits when the relay does.

| Environment | Default | |
| --- | --- | --- |
| `REBELLM_SIDECAR` | `sidecar/index.ts` beside the binary, up to two directories above it, or in the working directory | the sidecar's entry file |
| `REBELLM_NODE` | `node` | the Node.js binary |

The sidecar has no dependencies; Node.js runs its TypeScript sources as they are.

## Container image

```sh
docker build -t rebellm-relay .
docker run -v relay-data:/data -p 9090:9090 rebellm-relay
```

The image builds the relay in a Rust stage and runs it on the Node.js image the sidecar needs,
as the user `node`, with the key and the statistics in the volume `/data`. It also answers the
commands of the Node.js relay's image, `node index.ts <options>` and
`node peer-id.ts <key file>`, so a deployment written for that image runs this one.
[docs/deploy-parity.md](docs/deploy-parity.md) lists what is the same, what differs, and what
a deployment of the Node.js relay has to change.

## Test

```sh
npm run check
```

runs `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, the TypeScript check,
ESLint, Prettier, the sidecar's tests (`sidecar/*.test.ts`) and the black-box suite
(`compat/*.test.ts`), which starts the built relay and drives it with js-libp2p peers in the
versions the web app ships. The pre-commit hook runs the same on the staged snapshot.

[docs/test-parity.md](docs/test-parity.md) maps every test of the Node.js relay to its place
here.

The black-box suite sets a few knobs the Node.js relay's tests passed as function arguments.
They are for tests only: `REBELLM_TEST_PEER_PING_MS`, `REBELLM_TEST_PEER_SILENT_MS`,
`REBELLM_TEST_STREAMS_PER_LINK`, `REBELLM_TEST_RESERVATION_TTL_MS`,
`REBELLM_TEST_STATS_INTERVAL_MS`, and `REBELLM_TEST_THROTTLE_PRIVATE=1`, which makes the
identity throttle count loopback and private addresses too.

## Dependencies

`cargo deny check licenses sources` (needs [cargo-deny](https://github.com/EmbarkStudios/cargo-deny))
checks every crate's licence against `deny.toml`. `vendor/` holds rust-libp2p's relay and
gossipsub crates with the patches listed in their `PATCHES.md`
([relay](vendor/libp2p-relay/PATCHES.md), [gossipsub](vendor/libp2p-gossipsub/PATCHES.md)).

## Layout

| | |
| --- | --- |
| `src/` | the relay |
| `sidecar/` | statistics, memory history, admin API |
| `compat/` | black-box suite with js-libp2p peers |
| `vendor/` | patched rust-libp2p relay and gossipsub crates |
| `Dockerfile`, `docker/` | the image, and the previous image's commands |
| `openspec/specs/` | what the relay does, requirement by requirement |
| `docs/test-parity.md` | the Node.js relay's tests and where they are now |
| `docs/deploy-parity.md` | replacing the Node.js relay in a deployment |

## Licence

[PolyForm Strict 1.0.0](https://polyformproject.org/licenses/strict/1.0.0): free for personal and
other non-commercial use; no right to modify, redistribute or sell. See [LICENSE](LICENSE).
`vendor/` holds third-party code under its own licence.
