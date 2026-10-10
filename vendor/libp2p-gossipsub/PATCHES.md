# Patch to libp2p-gossipsub 0.50.0

This directory is the `libp2p-gossipsub` crate, version 0.50.0, as published on crates.io by
the rust-libp2p project, under the MIT licence stated at the top of its source files and in
its `Cargo.toml`. The root `Cargo.toml` replaces the crates.io crate with it
(`[patch.crates-io]`).

One change, marked `Patch:` in `src/behaviour.rs` (`Behaviour::on_connection_closed`):

**Subscriptions are sent again when one of a peer's connections closes and another is left,
and that connection's handler is woken.**

The relay closes a peer's older connection when the peer opens a new one: a browser that lost
its link silently redials while the relay still holds the dead connection. Unpatched, two
things then go wrong with a js-libp2p peer:

- gossipsub sends its subscriptions only over a peer's first connection. js-libp2p forgets a
  peer's subscriptions when its connection closes, so after the redial the browser does not
  know the relay subscribes to the announce topic and stops publishing to it;
- the handler of the new connection opens its stream to the peer only when it is polled with
  a message waiting, and a message queued later does not wake it, so gossip to the browser
  waits for whatever wakes the connection next (a ping, up to 10 s; never without one).

The relay's `compat/` test "a peer that connects again replaces its dead connection, and
gossip reaches it on the new one" fails without the patch.

The crate's integration tests (`tests/`) are not vendored; the unit tests in `src/` are kept
as they are and not run here.

When updating: copy the new release over this directory, re-apply the patch, and run
`npm run check`.
