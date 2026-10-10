# relay-identity-throttle Specification

## Purpose
New peer identities per remote address and hour, so a fresh key is not free.
## Requirements
### Requirement: Relay identity throttle
The relay SHALL admit at most a configurable number of new peer identities per remote address
per hour (default 5; `--new-peers` or `REBELLM_NEW_PEERS`, 0 turns it off) and SHALL refuse
further connections from that address until the hour passes. It SHALL count identities in
memory only, keyed by a hash of the address with a salt drawn at random at every start, SHALL
count IPv6 addresses by their /64 prefix, SHALL NOT count a peer id already seen from that
address within the hour, and SHALL exempt loopback and private addresses. It SHALL forget an
address once all of its counted identities are older than the hour, so its memory holds only
addresses seen within the last hour. Refused connections SHALL be counted and shown in the
status and verbose output.

#### Scenario: Sixth identity in an hour
- **WHEN** six peers with distinct ids connect from one public address within an hour
- **THEN** the first five are admitted and the sixth connection is refused

#### Scenario: Reconnect
- **WHEN** an admitted peer id connects again from the same address within the hour
- **THEN** it is admitted without counting against the limit

#### Scenario: Hour passed
- **WHEN** an address reached the limit and an hour has passed since its earliest counted identity
- **THEN** a new identity from it is admitted again

#### Scenario: Address forgotten
- **WHEN** an hour has passed since an address's newest counted identity, whether or not it connects again
- **THEN** the throttle holds no entry for it and counts it in no address total, and its next new identity counts as its first

#### Scenario: Behind a proxy
- **WHEN** peers arrive from a loopback or private address, as behind a reverse proxy
- **THEN** none is refused, whatever their number

#### Scenario: Nothing stored
- **WHEN** the relay restarts
- **THEN** it holds no address or hash from before, and a new salt makes the old hashes meaningless

