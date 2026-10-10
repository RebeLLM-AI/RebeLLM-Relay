# RebeLLM relay

The relay of the [RebeLLM](https://rebellm.ai) network: the one server browser peers need
to find each other. It carries no model traffic.

- **Bootstrap.** Browsers connect over WebSocket (libp2p, Noise, Yamux).
- **WebRTC signalling.** Circuit relay v2, limited to 2 minutes and 128 KiB per relayed
  connection: enough for offers, answers and candidates, nothing else.
- **Announce gossip.** Gossipsub for the peers' announces; undecodable ones are not forwarded.
- **Model file tokens.** Short-lived tokens a file server checks, for connected peers only.
- **Page-fetch proxy.** Optional `GET /fetch?url=` for private networks, public addresses only.
- **Statistics and admin API.** Daily CSV files without peer identifiers, the network's
  memory history and an admin API, kept by a Node.js sidecar the relay starts.

The relay is written in Rust on [rust-libp2p](https://github.com/libp2p/rust-libp2p) and
speaks to browsers running [js-libp2p](https://github.com/libp2p/js-libp2p).

> The port from the previous Node.js relay is in progress; this page grows with it.

## Build and check

Rust (stable) and Node.js 22.18 or newer.

```sh
npm install        # tooling, and the pre-commit hook
cargo build --release
npm run check      # cargo fmt, clippy, tests, ESLint, Prettier
cargo deny check licenses sources   # dependency licences, needs cargo-deny
```

## Licence

Free for personal, non-commercial use; no right to sell or modify. See [LICENSE](LICENSE).
`vendor/` holds third-party code under its own licence.
