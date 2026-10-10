# dev-tooling Specification

## Purpose
How the repository checks itself: one command, a pre-commit gate, and no machine settings in tracked files.
## Requirements
### Requirement: Single check command
The repository SHALL offer one command, `npm run check`, that runs `cargo fmt --check`,
`cargo clippy` with warnings as errors, `cargo test`, ESLint, the Prettier format check and
the Node.js tests, and SHALL exit non-zero when any of them fails.

#### Scenario: Clean tree
- **WHEN** `npm run check` runs on a tree whose code is formatted, lint-free and passes its tests
- **THEN** it exits 0

#### Scenario: Unformatted Rust
- **WHEN** a Rust source file is not formatted as `cargo fmt` writes it
- **THEN** `npm run check` exits non-zero

### Requirement: Pre-commit gate on the staged snapshot
`npm install` SHALL enable `.githooks/pre-commit`, which SHALL run the check command on a
copy of the staged snapshot, so unstaged changes cannot alter the result, and SHALL refuse
the commit when the check fails.

#### Scenario: Staged failure
- **WHEN** a staged file fails a check and a commit is attempted
- **THEN** the commit is refused

#### Scenario: Unstaged failure
- **WHEN** the staged snapshot passes and an unstaged edit would fail
- **THEN** the commit goes through

### Requirement: Machine settings stay out of tracked files
Toolchain locations, build directories and other settings of one machine SHALL live only in
gitignored files (`.cargo/config.toml`, `.githooks/local.sh`), which the pre-commit gate
SHALL honour when they exist.

#### Scenario: Local build directory
- **WHEN** `.cargo/config.toml` names a build directory and a commit is attempted
- **THEN** the gate builds into that directory and no tracked file names it

