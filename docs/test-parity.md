# Test parity with the Node.js relay

Every test of the Node.js relay this repository replaces, and where its cases are asserted
now. The previous relay had 102 tests in seven files.

- **Rust** — a unit test in `src/`, for code that became Rust. Same cases, same expected values.
- **sidecar** — the original `node:test` test, kept in `sidecar/` for code that stayed
  JavaScript.
- **compat** — a black-box test in `compat/` that starts the built relay and drives it with
  js-libp2p peers of the web app's versions, or over HTTP.

Status: **same** (the original test with only its imports changed), **ported** (same cases
against the new code), **adapted** (same cases, the feed or the reading changed, see the
note), **not ported** (with the reason).

| | Count |
| --- | --- |
| Original tests | 102 |
| Same, in the sidecar | 38 |
| Ported or adapted, every case kept | 62 |
| Ported without one case | 1 |
| Not ported | 1 |

## `lib.test.ts` (49)

| Original test | Now | Status |
| --- | --- | --- |
| starts on a free port with a stable key and stops | compat `relay.test.ts` same name; Rust `relay::starts_on_a_port_with_a_key_and_stops_and_a_taken_port_fails` | adapted: the port is picked by the test, `node.status` is the process |
| parses defaults and repeated announce addresses | Rust `options::parses_defaults_and_repeated_announce_addresses` | ported |
| the identity throttle defaults to 5 new peers per address and hour; 0 turns it off; junk fails | Rust `options::the_identity_throttle_defaults_…` | ported |
| the models secret comes from the flag or the environment, else no tokens | Rust `options::the_models_secret_…` | ported |
| with a models secret a connected peer gets a token on the model access protocol; without one it is unsupported | compat `relay.test.ts` same name | ported; the token is checked with nginx's formula |
| the fetch port can be moved or turned off; verbose comes from the flag or the environment | Rust `options::the_fetch_port_…` | ported |
| the stats file comes from the flag, else the environment; none by default | Rust `options::the_stats_file_…` | ported |
| the VRAM history listens on 9092 with statistics, elsewhere or nowhere when asked; never without them | Rust `options::the_vram_history_listens_on_9092_…` | ported |
| the admin key comes from the flag or the environment and opens the stats port | Rust `options::the_admin_key_…`; compat `http.test.ts` "the admin key also comes from the environment…" | ported |
| verbose lines: time, event, the last 8 characters of the peer id, transport, details | Rust `verbose::verbose_lines_…`, `announce::the_summary_names_…` | ported |
| watchRelay prints connections, announces, reservations and relayed streams | Rust `verbose::the_verbose_log_prints_…` | ported: the six lines, from the Rust log |
| watchRelay says so when the relay service cannot be watched | — | **not ported**: it guards a hook into js-libp2p's private relay methods; rust-libp2p reports reservations and circuits as events, so there is no such state |
| a real relay under watch prints a peer that connects, reserves a slot and is reached through it | compat `relay.test.ts` same name | ported |
| a relay lets 256 relayed connections through each link by default | Rust `relay::a_relayed_connection_is_for_signalling_only_…`, `relay::the_circuit_limits_…` | adapted: the js-libp2p service fields are the relay crate's configuration |
| a relay with streamsPerLink 1 refuses a peer its second relayed connection | compat `relay.test.ts` "a relay lets 256 … with 1 it refuses a peer its second relayed connection", "the link a peer is dialed through is bounded like the one dialing" | ported, `REBELLM_TEST_STREAMS_PER_LINK=1` |
| a relayed connection is for signalling only: limited, no stream without opt-in, cut past 128 KiB | compat `relay.test.ts` same name; Rust `relay::the_circuit_limits_…` | ported; the limit is read from the connection instead of the service's fields |
| a relay with a throttle admits one identity per address, refuses the next and logs it | compat `relay.test.ts` same name | ported, `--new-peers 1`, `REBELLM_TEST_THROTTLE_PRIVATE=1` |
| a peer that connects again replaces its dead connection, and gossip reaches it on the new one | compat `relay.test.ts` same name | ported; it found two gaps in rust-libp2p's gossipsub that the vendored crate patches (`vendor/libp2p-gossipsub/PATCHES.md`) |
| twenty peers from one address, as behind the proxy, are all admitted at once and all hear announces | compat `relay.test.ts` same name | adapted: the peers announce again every three seconds while the test waits, as nodes do; a peer outside the relay's mesh hears of a message through IHAVE gossip, which reaches a random part of them per heartbeat |
| the relay takes a proxy: no colocation penalty, 100 dials a second, 256 handshakes, 1000 reservations of 30 minutes | Rust `admission::the_relay_takes_a_proxy_…`, `relay::the_circuit_limits_…`, `relay::gossip_scores_no_peer_down_for_its_address`; compat `relay.test.ts` "the relay takes a proxy…" | adapted: js-libp2p's connection manager and monitor fields are the Rust constants and configuration |
| a peer that never answers pings is dropped after the silence; one that answers stays | compat `relay.test.ts` same name | adapted: the 500 ms are counted from before the dial, as rust-libp2p pings at once and js-libp2p after the first interval |
| freeReservations: the last close frees the slot and stops its timer; a replaced connection keeps it | compat `relay.test.ts` "the last close frees the reservation; a replaced connection keeps it" | adapted: the mock of js-libp2p's reservation store is a real peer; the timer case is the next test |
| a peer back after its reservation was freed keeps the new one past the old one’s TTL | compat `relay.test.ts` same name | ported, `REBELLM_TEST_RESERVATION_TTL_MS=4000`; "not expired" is shown by dialing through it |
| lists only external IPv4 interfaces | Rust `options::lists_only_external_ipv4_interfaces` | ported |
| prints announced addresses instead of local ones | Rust `options::prints_announced_addresses_instead_of_local_ones` | ported |
| creates the key once and reloads the same identity | Rust `keyfile::creates_the_key_once_and_reloads_the_same_identity` | ported |
| rejects announces a browser would not decode, so gossip does not forward them | Rust `announce::rejects_announces_…`; sidecar `stats.test.ts` same name; compat "undecodable announces are not forwarded…" | ported and same: the relay validates gossip, the sidecar what it records |
| an announce is parsed once for the validator, the statistics and the log | sidecar `stats.test.ts` same name; Rust `announce::an_announce_is_parsed_once_…` | adapted: the log's summary is Rust's, from the same single parse |
| peer-id.mjs prints the id the relay runs with | compat `relay.test.ts` "the peer id tool prints the id the relay runs with, also for a key js-libp2p wrote" | ported |
| relayLive: connections by transport and age, limits, gossip, throttle, counters, process and peers | Rust `live::relay_live_…`; sidecar `bridge.test.ts` "the live answer is the relay snapshot with the announcing peers…" | ported, split where the code is split |
| nodeProbe reads the process memory, the reservations and the announce subscribers | sidecar `bridge.test.ts` "a refresh asks the relay for a snapshot…"; Rust `process::the_process_figures_…` | adapted: the figures are the relay's, read from its snapshot |
| stats: every 5 minutes a total and a network row, the counts by field and the hot experts | sidecar `stats.test.ts` same name | adapted: relayed bytes arrive as the relay's `relayed` event instead of through a wrapped js-libp2p stream; every asserted row is unchanged |
| stats: the 256 hottest experts, most demand first, only those with any | sidecar `stats.test.ts` | same |
| stats: the network row carries the p99 event-loop lag beyond the sampling interval, in whole ms | sidecar `stats.test.ts`; Rust `process::the_lag_is_the_99th_percentile_…` | same |
| stats: a peer's strings are quoted in the counts, so they add no column, row or formula | sidecar `stats.test.ts` | same |
| countBytes adds both directions of a stream | compat `relay.test.ts` "relayed bytes are counted in both directions of a stream" | adapted: the wrapper of a js-libp2p stream is the relay crate's patched copy loop, measured on a real relayed stream |
| a real relay with a stats file keeps an announcing peer, counts relayed bytes and writes the files | compat `relay.test.ts` same name | adapted: the tick comes from a 9 s interval instead of a direct call, and the peer announces every second, as the statistics keep a peer for one interval; the validator-instance check is covered by the parse-once tests |
| reports: accepted when they decode, fit 2 KB and come from their own author | Rust `announce::reports_accepted_…`; compat "a report over 2 KB is rejected for gossip" | ported |
| reports: one flat row per report without its peer, at the tick, header once, in the order of the report | sidecar `stats.test.ts` | same |
| reports: a peer's strings are quoted like in peers.csv, and the rows between ticks are bounded | sidecar `stats.test.ts` | same |
| a real relay with a stats file writes a published report and passes it to nobody | compat `relay.test.ts` same name | ported, tick from a 6 s interval |
| stats: a tick appends to its UTC day's files, header once; the next UTC day starts new ones | sidecar `stats.test.ts` | same |
| stats: daily files past the retention are deleted unread at start and once a day; newer ones and other files stay | sidecar `stats.test.ts` | same |
| stats: the files from before the daily layout get no rows, lose their old ones daily and go once empty; history.json follows each tick | sidecar `stats.test.ts` | same |
| pruneCsv: the rows dropped and the dated or undated rows kept after the header | sidecar `stats.test.ts` | same |
| stats: a tick is not held behind a running prune | sidecar `stats.test.ts` | same |
| stats: the day counts hold each node and reporter once, start again on a new UTC day and stop at the cap | sidecar `stats.test.ts` | same |
| migrateStats: counts per day first, then the files without peer ids; a second run changes nothing | sidecar `stats.test.ts` | same |
| stats: watchStats migrates before the first tick and prune and logs it; no file then holds a peer id | sidecar `stats.test.ts` | same |

## `admin.test.ts` (13)

| Original test | Now | Status |
| --- | --- | --- |
| the column constants are the relay files headers | sidecar `admin.test.ts` | same |
| adminKey is scrypt with a salt from the domain and user, and the same for the same login | sidecar `admin.test.ts` | same |
| adminChecker accepts the login only, and refuses malformed headers and keys | sidecar `admin.test.ts` | same |
| adminChecker remembers a verified header and refuses past the waiting limit | sidecar `admin.test.ts` | same |
| the admin API answers 401 without the login and serves live and history with it | sidecar `admin.test.ts` | same |
| the admin handler passes other paths on, needs a key and is open only with null | sidecar `admin.test.ts` | same |
| splitCsv keeps quoted commas and doubled quotes | sidecar `admin.test.ts` | same |
| stepFor keeps a span within 400 points | sidecar `admin.test.ts` | same |
| aggregate sums the counts, keeps the gauges peak and averages the rest | sidecar `admin.test.ts` | same |
| the history reads the daily files into ticks, days, shares, reports, hot experts and files | sidecar `admin.test.ts` | same |
| the history reader rereads only a day whose files changed, and forgets deleted days | sidecar `admin.test.ts` | same |
| the admin API serves the history of a statistics directory | sidecar `admin.test.ts` | same |
| index.ts serves the admin API with --admin-key, and stops for a malformed key | compat `http.test.ts` "the relay serves the admin API with --admin-key, and stops for a malformed key"; Rust `the_admin_key_is_scrypt_…` (in `main.rs`); sidecar `index.test.ts` | ported |

## `history.test.ts` (14)

| Original test | Now | Status |
| --- | --- | --- |
| buckets: 6-hour keys, lower medians, min, max and the median peer count; closed ones as summaries | sidecar `history.test.ts` | same |
| buckets: at most 72 values for the medians, min and max from every tick | sidecar `history.test.ts` | same |
| rebuilt from peers.csv: two days give eight buckets with their medians and no peer id | sidecar `history.test.ts` | same |
| the whole history is kept; ?days gives the buckets that end within the last N days | sidecar `history.test.ts` | same |
| a tick's total row reads back, and every tick feeds the history | sidecar `history.test.ts` | same |
| read from the file line by line; no file is an empty history | sidecar `history.test.ts` | same |
| GET /stats/history: JSON with a five-minute cache, ?days=N, 404 for other /stats/ paths | sidecar `history.test.ts` | same |
| as a middleware: other paths go on, and the route too without statistics; 404 on its own server | sidecar `history.test.ts` | same |
| after a restart the relay holds the history of its peers.csv before the first tick | compat `http.test.ts` same name | adapted: read over `/stats/history` instead of from the JavaScript object |
| after a restart the relay holds the history of its daily peers files before the first tick | compat `http.test.ts` same name | adapted likewise |
| history.json, then the old peers.csv, then the daily files newer than it, each row once | sidecar `history.test.ts` | same |
| index.mjs serves the history rebuilt from --stats on --stats-port | compat `http.test.ts` "the relay serves the history rebuilt from --stats on --stats-port" | ported |
| a total row counts its RAM tiers; a row from before the RAM column counts VRAM only | sidecar `history.test.ts` | same |
| history.json: a save and restore round trip, then only the CSV rows newer than it are read | sidecar `history.test.ts` | same |

## `daily.test.ts` (2)

| Original test | Now | Status |
| --- | --- | --- |
| the day is the UTC date of the time | sidecar `daily.test.ts` | same |
| only the four daily names with a real date, oldest day first; no directory, none | sidecar `daily.test.ts` | same |

## `fetch.test.ts` (11)

| Original test | Now | Status |
| --- | --- | --- |
| blocks loopback, private, link-local, multicast and reserved addresses in every form | Rust `netaddr::blocks_loopback_…` | ported, every address of the list |
| a public page comes back with its type, the final URL and no-store; the checked address is dialled | Rust `fetch::a_public_page_comes_back_…` | ported |
| private addresses answer 403 without connecting, also when only one address or a redirect is private | Rust `fetch::private_addresses_answer_403_…` | ported |
| redirects are followed by hand up to five times, relative ones too | Rust `fetch::redirects_are_followed_…` | ported |
| only http and https URLs without credentials | Rust `fetch::only_http_and_https_urls_without_credentials` | ported |
| text types only, capped in size; an upstream error status is passed on | Rust `fetch::text_types_only_…` | ported |
| the whole exchange is cut at the time limit | Rust `fetch::the_whole_exchange_is_cut_at_the_time_limit` | ported |
| a token bucket per client address, keyed by the first X-Forwarded-For hop | Rust `fetch::a_token_bucket_per_client_address_…` | ported |
| other paths: 404 on its own server, next() as a middleware; GET only | Rust `fetch::other_paths_404_get_only`; compat `http.test.ts` "the relay serves the fetch proxy on --fetch-port" | **partly not ported**: the 404 and 405 cases are; passing to `next()` is not, the proxy is no longer a JavaScript middleware a dev server can mount |
| dial connects to the given address and keeps the host name for Host | Rust `fetch::dial_connects_to_the_given_address_…` | ported, gzip included |
| index.mjs serves the proxy on --fetch-port next to the relay | compat `http.test.ts` "the relay serves the fetch proxy on --fetch-port"; Rust `fetch::the_server_answers_over_http_…` | ported |

## `gate.test.ts` (10)

| Original test | Now | Status |
| --- | --- | --- |
| addressKey: the IPv4 address, the IPv6 /64 prefix, nothing for other multiaddrs | Rust `gate::address_key_…` | ported |
| admits five new identities per address and hour, then refuses; a known id reconnects freely | Rust `gate::admits_five_new_identities_…` | ported |
| the window slides: an identity counted an hour ago frees its slot | Rust `gate::the_window_slides_…` | ported |
| an address whose identities all left the window is forgotten, whether it comes back or not | Rust `gate::an_address_whose_identities_all_left_…` | ported |
| memory holds only the addresses of the last hour, not every address ever seen | Rust `gate::memory_holds_only_…` | ported |
| a refusal stores no entry: a limit of 0 refuses every new identity and keeps nothing | Rust `gate::a_refusal_stores_no_entry_…` | ported |
| one IPv6 /64 is one address; a limit of 0 or a window of 0 refuses nothing when off | Rust `gate::one_ipv6_64_is_one_address` | ported |
| loopback and private addresses are exempt by default, not when asked | Rust `gate::loopback_and_private_addresses_…` | ported |
| addresses live as salted hashes: two instances hash the same address differently | Rust `gate::addresses_live_as_salted_hashes_…` | ported |
| the gater denies at the encrypted-connection hook and reports each refusal | Rust `admission::the_gate_denies_once_the_peer_and_its_address_are_known_…` | ported: the hook is the swarm's established-inbound-connection check |

## `token.test.ts` (3)

| Original test | Now | Status |
| --- | --- | --- |
| a token is an hour ahead and signed as nginx's secure_link_md5 computes it | Rust `token::a_token_is_an_hour_ahead_…` | ported |
| the check answers as the file server does: ok, expired for a signed past expiry, bad otherwise | Rust `token::the_check_answers_as_the_file_server_does_…` | ported |
| the cookies carry the expiry and the signature; only the binaries need them | Rust `token::the_cookies_carry_…` | ported |

## Not ported

1. **watchRelay says so when the relay service cannot be watched.** The Node.js relay wrapped
   two private methods of js-libp2p's relay service and printed a note when a new version no
   longer had them. rust-libp2p reports reservations and circuits as events; there is nothing
   to be missing.
2. **The `next()` case of "other paths: 404 on its own server, next() as a middleware".** The
   proxy was also a connect middleware for a JavaScript dev server. It is a Rust HTTP service
   now; the 404 and the GET-only cases of the same test are ported.

## Added here

Tests with no counterpart in the Node.js relay: the sidecar bridge and its line protocol
(`sidecar/bridge.test.ts`, `sidecar/index.test.ts`), a sidecar that dies or cannot be started
(`compat/http.test.ts`, Rust `sidecar::*`), gossipsub message ids as js-libp2p computes them
(Rust `relay::a_message_id_…`), a key file written by js-libp2p (`compat/relay.test.ts`),
undecodable announces and oversized reports over real gossip, a peer without the ping
protocol, the destination link's limit, and the helpers that keep JavaScript's text formats
(Rust `util::*`).
