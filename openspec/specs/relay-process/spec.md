# relay-process Specification

## Purpose
The relay as browser peers and operators see it: transports, limits, command line, log, reservations, and compatibility with js-libp2p.
## Requirements
### Requirement: Relay process
The relay SHALL listen on WebSocket, provide circuit relay v2 and gossipsub, and print its
multiaddr on start. It SHALL keep its identity in the key file named by `--key`, created on
first run, so its peer id stays the same across restarts.

The relay's circuit SHALL serve WebRTC signalling only: every relayed connection SHALL be
limited to 2 minutes and 128 KiB, so that peers can exchange their WebRTC offers, answers and
candidates through it but no expert traffic flows through the relay.

The relay SHALL ping every connected peer every 10 s and SHALL drop a peer's connection only
once the peer has answered no ping for 45 s: a browser whose page is busy with a prompt keeps
its link, and one that vanished without closing frees its connection within a minute.

The relay SHALL allow at least 256 relayed connections open at once through each peer's link,
both those the peer dialed and those dialed to it.

#### Scenario: Relay start
- **WHEN** `rebellm-relay --port 9090` runs
- **THEN** it prints a `/ip4/.../tcp/9090/ws/p2p/<id>` address and accepts connections

#### Scenario: Same key, same identity
- **WHEN** the relay runs twice with the same key file, on different ports
- **THEN** each run has the same peer id and stops cleanly

#### Scenario: Busy peer
- **WHEN** a connected peer answers no ping for 20 s and then answers again
- **THEN** its connection is still open

#### Scenario: Vanished peer
- **WHEN** a connected peer stops answering pings for good
- **THEN** the relay closes its connection between 45 s and 60 s after the first unanswered ping

#### Scenario: Signalling only
- **WHEN** a peer dials another through the relay's circuit
- **THEN** the connection is limited to 2 minutes and 128 KiB, a protocol that does not run on limited connections cannot open a stream on it, and a stream that sends more than 128 KiB is cut

### Requirement: Command line of the previous relay
The relay SHALL accept the options of the Node.js relay it replaces, with the same defaults,
environment variables and error messages: `--port` (9090), `--host` (0.0.0.0), `--key`
(`relay-key.bin`), `--announce` (repeatable), `--fetch-port` (`REBELLM_FETCH_PORT`, off by
default), `--verbose` (`REBELLM_RELAY_VERBOSE=1`), `--stats` (`REBELLM_RELAY_STATS`),
`--stats-port` (`REBELLM_STATS_PORT`; 9092 with statistics or an admin key, 0 turns it off),
`--new-peers` (`REBELLM_NEW_PEERS`, 5), `--models-secret` (`REBELLM_MODELS_SECRET`),
`--admin-key` (`REBELLM_ADMIN_KEY`) and `--help`. A flag SHALL win over its environment
variable, and an empty environment value SHALL count as unset. On start it SHALL print
`relay <peer id> listening on <host>:<port>` and the bootstrap addresses: the announced ones,
else loopback and every external IPv4 address, each ending in `/p2p/<peer id>`.

`rebellm-relay-peer-id <key file>` SHALL print the peer id of a key file without starting a
relay. A key file written by the Node.js relay SHALL give the same peer id.

#### Scenario: Defaults
- **WHEN** the relay is started without options or environment
- **THEN** it listens on 0.0.0.0:9090 with the key `relay-key.bin`, no fetch proxy, no statistics, no HTTP port, and 5 new identities per address and hour

#### Scenario: Invalid port
- **WHEN** the relay is started with `--port 70000`
- **THEN** it exits non-zero with `invalid port 70000`

#### Scenario: Help
- **WHEN** the relay is started with `--help`
- **THEN** it prints the usage with every option and exits 0

#### Scenario: Key of the Node.js relay
- **WHEN** `rebellm-relay-peer-id` reads a key file the Node.js relay wrote
- **THEN** it prints the peer id that relay ran with

### Requirement: Wire compatibility with js-libp2p browsers
The relay SHALL interoperate with peers running the js-libp2p versions of the RebeLLM web app
(libp2p 3, `@libp2p/websockets` 10, `@chainsafe/libp2p-noise` 17, `@chainsafe/libp2p-yamux` 8,
`@libp2p/circuit-relay-v2` 4, `@libp2p/gossipsub` 17, `@libp2p/identify` 4, `@libp2p/ping` 3):
WebSocket transport, Noise, Yamux, identify, ping, the circuit relay v2 hop and stop
protocols, and gossipsub with signed messages. It SHALL compute gossipsub message ids as
js-libp2p does for signed messages (the author's public key in its protobuf form followed by
the sequence number as 8 big-endian bytes), so both sides name a message alike. A black-box
suite SHALL run js-libp2p peers of those versions against the built relay.

#### Scenario: Browser stack
- **WHEN** a js-libp2p peer configured like the web app, without WebRTC, dials the relay, reserves a circuit slot, subscribes to the announce topic and publishes
- **THEN** the dial, the reservation, the subscription and the delivery to other peers all succeed

#### Scenario: Message ids
- **WHEN** a js-libp2p peer publishes a signed message with a given sequence number
- **THEN** the relay's id for it is the peer's protobuf public key followed by that sequence number in 8 big-endian bytes

### Requirement: Relay verbose log
The relay SHALL print, when started with `--verbose` or `REBELLM_RELAY_VERBOSE=1`, one
console line per connection open and close, announce, circuit reservation and relayed
stream, with the time, the event, the peer id's last eight characters and the transport;
without the flag it SHALL print peer counts on change only, and it SHALL write no log file.

#### Scenario: Node joins a verbose relay
- **WHEN** a browser node connects and announces
- **THEN** the console shows an open line with its transport and an announce line with the model, its expert count and its GPU class

### Requirement: Relay replaces stale connections
The relay SHALL close a peer's older connections when the same peer opens a new one, so its
gossip to that peer goes over the new connection.

#### Scenario: Reconnect after a silent drop
- **WHEN** a browser redials while the relay still holds its dead connection
- **THEN** the relay closes the dead connection and the browser receives announces over the new one

### Requirement: Relay behind a reverse proxy
The relay SHALL serve peers that all arrive from one address, as behind the site's reverse
proxy or the dev server's. Its gossipsub SHALL NOT score peers down for sharing an IP address.
Its connection manager SHALL admit at least 100 new connections per second from one source
host, with up to 256 handshakes in flight, within its cap of 1 000 connections. Limits per real
client address SHALL be left to the proxy.

#### Scenario: Twenty browsers behind one proxy
- **WHEN** 20 peers dial the relay from one address at the same moment, subscribe to the announce topic and each publish an announce
- **THEN** every dial succeeds on its first try, the relay counts 20 subscribers, and every peer receives announces of other peers through the relay

#### Scenario: Limits in force
- **WHEN** the relay starts
- **THEN** its gossipsub colocation weight is 0, and its connection manager admits 100 connections per second per host with 256 handshakes pending and 1 000 connections at most

### Requirement: Relay reservations
The relay SHALL hold at most as many circuit relay reservations as connections (1 000), each for
30 minutes unless the peer renews it. It SHALL free a peer's reservation as soon as the peer's
last connection to the relay closes. A connection closed because the same peer opened a newer
one SHALL NOT free it.

#### Scenario: Peer leaves
- **WHEN** a peer holding a reservation disconnects from the relay
- **THEN** the relay holds no reservation for it, and the slot is free for another peer at once

#### Scenario: Connection replaced
- **WHEN** a peer holding a reservation opens a new connection and the relay closes the older one
- **THEN** the peer's reservation stays

#### Scenario: Back after leaving
- **WHEN** a peer whose reservation was freed on disconnect connects and reserves again
- **THEN** it gets a new reservation, and no timer of the freed one removes it later

