# relay-statistics Specification

## Purpose
The statistics the relay keeps without peer identifiers, its memory history, and the Node.js sidecar that keeps them.
## Requirements
### Requirement: Relay peer statistics
With `--stats <file>` or `REBELLM_RELAY_STATS`, the relay SHALL keep the latest accepted
announce per connected peer in memory and append every 5 minutes, to `peers-YYYY-MM-DD.csv`
in that file's directory (the UTC day of the tick), with the header
(`time,row,transport,model,gpu,precision,vram_bytes,budget_bytes,loaded,served,calls_per_sec,app,ram_bytes,relayed_bytes,loop_lag_ms,rss_bytes,heap_bytes,reservations,subscribers,opened,streams,refused,tokens,calls_per_sec_sum`),
one `total` row with the sums over the peers seen within the last 5 minutes and, under
`calls_per_sec`, their count, a `network` row (connections open
and by transport, median connection age, replicas per expert min, median, max and the
count with none, bytes relayed since the last tick, and under `loop_lag_ms` the 99th
percentile of the relay's event-loop lag since the previous tick in whole milliseconds),
and the tick's 256 hottest experts
from the summed demand histograms to `hot-YYYY-MM-DD.csv` beside it (`time,layer,expert,demand`);
it SHALL write no row per peer. Every tick it SHALL also append to `counts-YYYY-MM-DD.csv`
beside it (`time,set,field,value,count`), a row per set, field and value with the count:
set `live` for the peers seen within the last 5 minutes, and set `nodes` for the distinct
peers seen within a tick so far on the UTC day, each with field `all` (empty value, the count)
and fields `gpu`, `precision`, `app`, `transport`, `model` and `budget` (the expert budget's
power-of-two bucket in GiB: `<1GiB`, `1-2GiB` up to `32GiB+`), an empty value meaning unknown;
and set `reporters` for the distinct peers whose usage reports were written so far on the UTC
day, with field `all` and fields `app`, `gpu`, `precision`, `phone` (`phone` or `desktop`),
`browser` and `os`.
Each daily file SHALL get its header when the tick that first writes to it creates it, and a
tick SHALL only append, never rewrite a file; strings from peers SHALL be
CSV-quoted. The `total` row's `relayed_bytes` SHALL be the bytes relayed through the circuit
since the previous tick for the listed peers, counted for both ends of each relayed stream,
and its `calls_per_sec_sum` the sum of their announced calls per second. The `total` row SHALL
leave `loop_lag_ms` empty.
The `network` row SHALL fill the eight columns from `rss_bytes` to `tokens`: the relay process's
resident and used heap memory in bytes, its circuit reservations and the announce topic's
subscribers at the tick, and the connections opened, relayed streams, identities refused and
model file tokens issued since the previous tick. The `total` row SHALL leave those eight empty.
At start and once a day the relay SHALL delete every daily statistics file (`peers-`, `hot-`,
`reports-` or `counts-` followed by the date and `.csv`) whose day began more than 12 months
ago, without reading its rows, and SHALL leave every other file in the directory untouched.
Files written before the daily layout (the `--stats` file itself, `hot.csv` and `reports.csv`
beside it) SHALL receive no new rows; at start and once a day the relay SHALL drop their rows
older than 12 months and SHALL delete each once no row is left in it. Without the option
nothing is written.

#### Scenario: Two peers, one leaves
- **WHEN** two peers announce, one disconnects, and a tick passes
- **THEN** the day's peers file has the header and a total row counting one peer and no row per peer, and the counts file's `live` set counts one node and its `nodes` set two

#### Scenario: Next day
- **WHEN** a tick passes at 23:55 UTC and the next one at 00:00 UTC
- **THEN** the second tick's rows go to new files for the new day, which start with their headers, and the previous day's files are left as they were

#### Scenario: Relayed bytes summed
- **WHEN** a stream relayed between peers A and B carries 150 bytes and both announce
- **THEN** the tick's total row shows 300 under `relayed_bytes`, and the next tick starts from 0

#### Scenario: Event-loop lag recorded
- **WHEN** the relay's event loop ran up to 15 ms late at the 99th percentile since the previous tick and a tick passes
- **THEN** the `network` row shows 15 under `loop_lag_ms`, the total row leaves it empty, and the next tick measures from zero

#### Scenario: Relay load recorded
- **WHEN** since the previous tick two connections opened, one stream was relayed and one model token was issued, and at the tick the relay holds one reservation
- **THEN** the `network` row shows the process memory, 1 under `reservations`, 2 under `opened`, 1 under `streams`, 0 under `refused` and 1 under `tokens`, and the next tick counts from zero

#### Scenario: A year old
- **WHEN** the relay starts with daily files from a day 13 months ago and from yesterday, and an unrelated file, in the directory
- **THEN** the 13-month-old day's files are deleted and yesterday's files and the unrelated file stay

#### Scenario: Files from before the daily layout
- **WHEN** the relay starts with a `peers.csv` holding rows from 13 months ago and from last month
- **THEN** the old rows are dropped, last month's stay, no new row is appended to it, and once last month's rows are older than 12 months the file is deleted

### Requirement: Relay records usage reports
The relay SHALL validate usage reports for gossip like announces (decodable, under 2 KB,
from the message's own peer) and, with `--stats`, append each accepted report as one row
without its peer id to `reports-YYYY-MM-DD.csv` beside the daily peers file (the UTC day of
the tick that writes it), stamped with that tick's time, header once, strings quoted. The
peer id SHALL be used in memory only, for the day's distinct reporters.

#### Scenario: Report recorded
- **WHEN** a peer publishes a valid report and the relay runs with `--stats`
- **THEN** the day's reports file gains a row with the tick's time, the machine fields and the numbers, and no peer id, and the day's `reporters` set counts the peer once

#### Scenario: Oversized report
- **WHEN** a peer publishes a 5 KB report
- **THEN** the relay rejects it for gossip and writes nothing

### Requirement: Relay VRAM history
The relay SHALL keep, from its statistics, the whole history of the network's expert memory
(the announced VRAM budgets plus the announced RAM tiers; rows written before the RAM column
count VRAM only) in 6-hour buckets (median, min, max, median peer count), rebuilt at start from
its saved history and then the rows newer than it in the `--stats` file from before the daily
layout and in the daily peers files, and updated every tick, and SHALL serve it as JSON at
`GET /stats/history` on its HTTP port with a five-minute cache header, the last N days only with
`?days=N`; no peer identifier SHALL appear in it.

#### Scenario: After a restart
- **WHEN** the relay restarts with a `peers.csv` or with daily peers files holding two days of total rows
- **THEN** `/stats/history` lists eight buckets with their medians before the first new tick

#### Scenario: Old and daily files together
- **WHEN** the relay restarts with a saved history, a `peers.csv` from before the daily layout and daily peers files, some rows in them older than the saved history
- **THEN** the history holds every bucket once, each row counted once, in time order

#### Scenario: RAM tiers counted
- **WHEN** a total row sums 40 GB of expert VRAM and 80 GB of RAM
- **THEN** its bucket's median is 120 GB

#### Scenario: Other paths
- **WHEN** `/stats/anything-else` is requested
- **THEN** the answer is 404

### Requirement: Relay statistics hold no peer identifiers
The relay SHALL NOT write a peer id or a public key to any file of its statistics (the daily
`peers-`, `hot-`, `reports-` and `counts-` files, the single files from before them and
`history.json`). Peer ids the statistics need (the distinct nodes and reporting browsers
of the UTC day) SHALL be held in memory only, at most 100 000 per set and day, and SHALL be
dropped at the first tick of the next UTC day. After a restart the day's distinct counts
SHALL start again from zero.

At start, before its first prune and tick, the relay SHALL rewrite every daily peers or
reports file and the single `peers.csv` (the `--stats` file) and `reports.csv` that still
hold peer ids: a peers file holds them when its header names `peer` or a data row's second
cell is neither `total` nor `network`; a reports file when its header names `peer` or a data
row's second cell is a peer id. For each UTC day with such rows and no counts file, it SHALL
first write that day's counts file with the `nodes` and `reporters` sets computed from those
rows, stamped with the day's last such row time; a day that has a counts file SHALL keep it
unchanged. It SHALL then rewrite each such file through a temporary file and a rename,
peers files with the current header and only their `total` and `network` rows, reports files
with the current header and without the `peer` cell. It SHALL log one line per file
rewritten and per counts file written. A second start SHALL find nothing to rewrite.

#### Scenario: No written file holds a peer id
- **WHEN** two peers announce, one publishes a usage report, and ticks pass
- **THEN** no file in the statistics directory contains either peer id

#### Scenario: Day change clears the ids
- **WHEN** a node announces on one UTC day and another node on the next
- **THEN** the first tick of the next day counts one distinct node, not two

#### Scenario: Old files rewritten
- **WHEN** the relay starts with a peers file holding per-peer rows of two peers and a reports file with a `peer` column, for a day without a counts file
- **THEN** the day's counts file shows 2 distinct nodes and 1 distinct reporter with their shares, the peers file keeps its `total` and `network` rows only, the reports file keeps its rows without the `peer` cell, and no file holds a peer id

#### Scenario: Started again
- **WHEN** the relay starts again on the rewritten files
- **THEN** it rewrites nothing and writes no counts file

### Requirement: Statistics sidecar
A Node.js sidecar SHALL keep the relay's statistics files, its memory history and its HTTP
port (`/stats/history` and the admin API); the relay SHALL start it as a child process when
`--stats` is set, or an admin key with an HTTP port. The relay SHALL own everything a peer can
observe (connections, limits, gossip, reservations, tokens, the fetch proxy) and its counters.

The two SHALL talk over the sidecar's standard input and output, one JSON object per line.
The relay SHALL send its options, every connection opened and closed, every accepted announce
and usage report, and the bytes relayed per circuit; the sidecar SHALL ask the relay for a
snapshot (the live answer without the announcing peers) when a tick or an admin request needs
one, and SHALL pass its log lines to the relay, which prints them.

The relay SHALL run correctly without the sidecar: when the sidecar cannot be started, exits
or stops answering, the relay SHALL keep serving peers, SHALL drop the events it cannot
deliver, SHALL say so on its console, and SHALL start the sidecar again with a growing delay
of at most a minute. The sidecar SHALL exit when its input closes, so it never outlives the
relay.

The `network` row's `loop_lag_ms` and the process figures SHALL describe the relay process:
the lag is the 99th percentile of how late a 20 ms timer on the relay's runtime fired, and the
heap figure the bytes the relay has allocated.

#### Scenario: No statistics, no sidecar
- **WHEN** the relay runs without `--stats` and without an admin key
- **THEN** no sidecar process is started and no HTTP port is opened

#### Scenario: Sidecar dies
- **WHEN** the sidecar process is killed while peers are connected
- **THEN** the peers stay connected and keep exchanging announces, the relay prints that the sidecar exited, and a new sidecar serves `/stats/history` again within seconds

#### Scenario: Sidecar missing
- **WHEN** the relay is started with `--stats` and the sidecar cannot be started
- **THEN** the relay still accepts connections and relays, and prints why the statistics are not kept

#### Scenario: Relay stops
- **WHEN** the relay process ends, cleanly or not
- **THEN** the sidecar process ends too

