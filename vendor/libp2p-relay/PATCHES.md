# Patches to libp2p-relay 0.22.0

This directory is the `libp2p-relay` crate, version 0.22.0, as published on crates.io by the
rust-libp2p project, under the MIT licence stated at the top of its source files and in its
`Cargo.toml`. The root `Cargo.toml` replaces the crates.io crate with it (`[patch.crates-io]`).

Every change is marked `Patch:` in the source. The relay needs them because the crate offers
no other way to do the same:

1. **Bytes relayed, as they pass** (`Config::circuit_bytes`, `CircuitBytes`,
   `handler::Config::{remote_peer_id, circuit_bytes}`, `CopyFuture::with_on_bytes`). A callback
   gets a circuit's source, destination and the size of every chunk forwarded. The relay's
   statistics count relayed bytes per tick and per peer.
2. **The byte limit is exact** (`copy_future::forward_data`). A chunk is cut at
   `max_circuit_bytes`; unpatched, a circuit passes the limit by up to one buffer.
3. **The destination's link is bounded too** (`Behaviour::on_connection_handler_event`). A
   circuit is refused when the peer dialed to already carries `max_circuits_per_peer`
   circuits, as for the peer dialing.
4. **Reservations can be read** (`Behaviour::reservations`, `Behaviour::has_reservation`).
5. **A reservation survives a replaced connection** (`Behaviour::on_connection_closed`). When
   the connection a reservation was made over closes while the peer has another one, the
   reservation moves to that connection; `Event::ReservationClosed` is emitted only when a
   reservation really ends (unpatched, it is emitted for every closed connection).

6. **256 requests in flight per connection** (`handler::MAX_CONCURRENT_STREAMS_PER_CONNECTION`,
   10 upstream). Forty browsers may dial one peer in the same second; each is a stop request
   on that peer's link.

The crate's integration tests (`tests/`) are not vendored: they need test-only crates of the
rust-libp2p workspace. The relay's own `compat/` suite covers the patched behaviour.

When updating: copy the new release over this directory, re-apply the patches above, and run
`npm run check`.
