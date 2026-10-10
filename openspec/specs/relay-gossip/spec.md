# relay-gossip Specification

## Purpose
What the relay forwards over gossipsub: valid announces to everyone, usage reports to nobody.
## Requirements
### Requirement: Announce validation
The relay SHALL subscribe to `rebellm/announce/1` and forward only announces a browser would
decode: JSON with `v` 1, a string `model`, whole positive `layers` and `experts` whose product
is at most 2^20, a base64 `served` bitset of exactly ceil(layers x experts / 8) bytes, and,
when present, a `hot` bitset of the same size and a `demand` of 2 bytes per expert. Any other
announce SHALL be rejected for gossip. Accepted and rejected announces SHALL be counted.

#### Scenario: Undecodable announce
- **WHEN** a peer publishes bytes that are not such an announce
- **THEN** the relay does not forward them and counts a rejected announce

#### Scenario: Valid announce
- **WHEN** a peer publishes a valid announce
- **THEN** the other subscribed peers receive it through the relay

### Requirement: Usage report validation
The relay SHALL subscribe to `rebellm/report/1` and accept a usage report only when it is
JSON with `v` 1, at most 2 KB, signed, and delivered by its own author. It SHALL forward no
report to any peer: an accepted report is for the relay operator only. Accepted and rejected
reports SHALL be counted.

#### Scenario: Report from its author
- **WHEN** a peer publishes a valid report
- **THEN** the relay counts it as accepted and no other peer subscribed to the topic receives it

#### Scenario: Oversized report
- **WHEN** a peer publishes a 5 KB report
- **THEN** the relay rejects it for gossip

