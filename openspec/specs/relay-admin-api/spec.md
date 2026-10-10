# relay-admin-api Specification

## Purpose
The admin API on the relay's stats port: a live snapshot of the relay and the history its statistics recorded, behind the admin login.
## Requirements
### Requirement: Relay admin API

With an admin key (`--admin-key <key>` or `REBELLM_ADMIN_KEY`), the relay SHALL answer
`GET /admin/api/live` and `GET /admin/api/history[?days=N]` on its HTTP port, the port of
`/stats/history`, which then defaults to 9092 as with `--stats`. Without a key, every
`/admin/api/` path SHALL answer 404. A malformed key SHALL stop the relay at start.

**The key.** It SHALL be `scrypt.<salt>.<hash>`: a scrypt hash of `user:password` with its
salt, both base64url. The relay SHALL answer 401 with a `WWW-Authenticate: Basic` challenge
to a request whose `Authorization` header does not match the key, and SHALL NOT keep any
credential in plain text.

**Answers.** Every answer SHALL be JSON with `Cache-Control: no-store`.

**Counters.** The relay SHALL count, from its start and in memory only:

- connections opened and closed;
- identities refused;
- reservations granted and refused;
- relayed streams and bytes;
- announces accepted and rejected;
- usage reports accepted and rejected;
- model file tokens issued.

**`/admin/api/live`.** SHALL return a snapshot of:

- the counters;
- the open connections, by transport and by distinct peer, with their median and oldest age;
- the reservations and the relay's limits;
- the gossip peers, and the subscribers and mesh of the announce and report topics;
- the identity throttle;
- the relay process's memory, CPU time and event-loop lag;
- with statistics, the announcing peers: their sums and replicas, and one row per peer.

While the relay's snapshot is not available, `/admin/api/live` SHALL answer 503.

**`/admin/api/history`.** SHALL return, from the daily files and the saved history, for the
last N days (1 to 36 500) or everything kept without `days`:

- **the expert memory buckets;**
- **the `network` and `total` rows as ticks,** aggregated to a step that keeps at most 400
  points;
- **one row per UTC day,** with the day's distinct nodes and reporting browsers from its
  counts file;
- **the peers' shares** by GPU, app, precision, transport and model, from the days' `nodes`
  sets summed over the range, so a peer counts once per day it was seen;
- **the usage reports:** sums, medians and distributions, the distributions and the
  reporter count from the days' `reporters` sets summed the same way;
- **the hottest experts** over the range;
- **the daily files kept,** with the bytes of the peers, reports, hot and counts files.

For each day and set the history SHALL use the tick with the highest `all` count, the latest
of equal ones, so a day with a restart shows the larger of the counts before and after it.
The relay SHALL read a peers or reports file's columns by its header, so files with and
without the `peer` column read alike, and SHALL ignore rows per peer.
The ticks SHALL be those within the range. The per-day figures (the day rows, shares,
reports and hot experts) SHALL cover every UTC day that overlaps the range, and the answer
SHALL name the first such day. Without statistics, the answer SHALL say so and carry the
memory buckets only. No peer id SHALL appear in the history answer.

#### Scenario: No key

- **WHEN** the relay runs without an admin key and `/admin/api/live` is requested on its HTTP port
- **THEN** the answer is 404

#### Scenario: Wrong login

- **WHEN** the relay has a key and a request carries another user's or password's `Authorization` header, or none
- **THEN** the answer is 401 with a `WWW-Authenticate: Basic` header and no statistics

#### Scenario: Right login

- **WHEN** the relay has the key of `admin:secret-for-tests` and a request carries that login
- **THEN** `/admin/api/live` answers 200 with the counters and the connections

#### Scenario: Counted

- **WHEN** a peer connects, reserves a slot and publishes an announce the validator accepts
- **THEN** the live snapshot's `connectionsOpened`, `reservationsGranted` and `announcesAccepted` have each grown by one

#### Scenario: Range

- **WHEN** `/admin/api/history?days=7` is requested and the daily files hold 10 days
- **THEN** the ticks are those of the last 7 days, the day rows and distributions cover the 8 UTC days that overlap them, and the memory buckets are those that end within them

#### Scenario: Bad range

- **WHEN** `/admin/api/history?days=0` or `?days=x` is requested
- **THEN** the answer is 400

#### Scenario: Old files

- **WHEN** a day's peers file was written before the network row's newer columns
- **THEN** its ticks carry no value for those columns and the rest of the row is read as before

#### Scenario: Shares over two days

- **WHEN** the same node is counted in the `nodes` sets of two days in the range
- **THEN** the day rows show it on each day, and the peers' count and shares count it twice

#### Scenario: Restart mid-day

- **WHEN** a day's `nodes` set reaches 5, the relay restarts, and the set reaches 3 by the day's end
- **THEN** the day row shows 5 distinct nodes

