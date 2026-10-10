# relay-image Specification

## Purpose
The container image of the relay, and the commands of the Node.js relay image it still answers.
## Requirements
### Requirement: Relay image
The repository SHALL provide a `Dockerfile` whose image holds the relay, the peer id tool and
every non-test module of the sidecar, and no test file. The image SHALL run as an
unprivileged user, SHALL keep the relay's key and statistics in the volume `/data` and write
nowhere else, SHALL expose 9090 (libp2p over WebSocket), 9091 (fetch proxy) and 9092
(history and admin API), and SHALL start the relay on port 9090 with the key
`/data/relay-key.bin` by default. The relay in the image SHALL find its sidecar without
further settings.

#### Scenario: Image start
- **WHEN** the image is run with the command `rebellm-relay --help`
- **THEN** it prints the relay's usage and exits 0

#### Scenario: Read-only root
- **WHEN** the container runs with a read-only root file system and `--stats /data/peers.csv`
- **THEN** the relay starts, its sidecar writes the statistics to `/data`, and nothing fails for want of a writable path

#### Scenario: No tests in the image
- **WHEN** the image is built
- **THEN** it contains no `*.test.ts` file

### Requirement: Commands of the previous image
The image SHALL answer the two commands the previous relay image was run with, from its
working directory: `node index.ts <relay options>` SHALL run the relay with those options, and
`node peer-id.ts <key file>` SHALL print the peer id of the key file. Each SHALL pass on the
standard output and error of the program it starts, forward SIGINT and SIGTERM to it, and end
with its exit code.

#### Scenario: Compose command of the previous relay
- **WHEN** the container is started with `node index.ts --port 9090 --key /data/relay-key.bin --announce /dns4/relay.example.org/tcp/443/wss`
- **THEN** the relay listens on 9090 and prints the announced bootstrap address

#### Scenario: Peer id of a running relay
- **WHEN** `node peer-id.ts /data/relay-key.bin` is run in the container
- **THEN** it prints the peer id the relay runs with and exits 0

#### Scenario: Stop
- **WHEN** the container started with `node index.ts ...` receives SIGTERM
- **THEN** the relay receives it, stops, and the container exits with the relay's exit code

#### Scenario: Failure passed on
- **WHEN** `node index.ts --port 70000` is run
- **THEN** it prints `invalid port 70000` and exits non-zero

