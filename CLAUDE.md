# CLAUDE.md

Project: the RebeLLM relay. Bootstrap, WebRTC signalling (circuit relay v2), announce gossip,
model file tokens and a page-fetch proxy for RebeLLM browser peers. The relay is Rust
(`src/`, rust-libp2p); its statistics and admin API run in a Node.js sidecar (`sidecar/`).
Black-box tests that drive the built binary with js-libp2p peers live in `compat/`, specs in
`openspec/`, the test parity table in `docs/test-parity.md`.

## All code changes go through the OpenSpec flow

Never write or modify code before a spec exists. No exceptions for "small" fixes.

The order is fixed:

1. **Propose** with `/opsx:propose "<idea>"`. Creates the change under `openspec/changes/`
   with proposal, design, spec deltas and tasks. Review it before moving on.
2. **Apply** with `/opsx:apply`. Implement only the tasks listed in the change. If
   implementation reveals the spec is wrong, stop and update the spec first.
3. **Archive** with `/opsx:archive`. Marks the change complete.
4. **Sync to main specs** with `openspec archive <change>` so the deltas are merged into
   `openspec/specs/`. Main specs are the source of truth for what the relay does.

Use `/opsx:explore` to think through an idea before proposing. Exploration produces no
code.

## Commits

Commit only finished work: a change that is applied, archived and synced to main specs. One
commit per completed change, not per artifact or task. Proposals, half-done tasks and work
in progress stay uncommitted. Never push unless asked.

## Tests and the pre-commit gate

- Every change ships tests for everything it adds or changes: `cargo test` for Rust
  (`src/**`, `tests/`), `node:test` for the sidecar (`sidecar/*.test.ts`) and for the
  black-box suite that runs js-libp2p peers against the built binary (`compat/*.test.ts`).
  Code without tests is not finished.
- A test ported from the previous relay keeps its cases. `docs/test-parity.md` maps every
  original test to its place here; update it when a test moves.
- `npm install` at the root enables `.githooks/pre-commit`, which runs `npm run check`
  (`cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, typecheck, ESLint,
  Prettier, the Node.js tests) on the staged snapshot. Never bypass it with `--no-verify`;
  fix the cause.
- `cargo deny check` verifies the dependency licences against `deny.toml`; run it when a
  dependency changes.

## Wire compatibility

Browsers run js-libp2p. A change to a protocol, a limit a peer can observe, a file format
or an HTTP answer needs a `compat/` test that shows a js-libp2p peer still works.

## This repository is public

- No secrets, tokens, real keys, logins, internal host names or addresses, personal names
  or e-mail addresses, and no paths of one machine in any tracked file, test, spec or
  commit message. Tests use made-up keys.
- Machine settings (build directory, toolchain location) go to the gitignored
  `.cargo/config.toml` and `.githooks/local.sh`.

## Comments

Keep comments short. One line where possible. Say why, not what. Do not restate the code.
Do not leave commented-out code.

## Repository notes

- `openspec/changes/archive/` is gitignored. Archived changes are local history only;
  the merged specs in `openspec/specs/` are what gets committed.
- `vendor/libp2p-relay` is rust-libp2p's relay crate with the patches listed in its
  `PATCHES.md`; keep that list complete.
- Everything is in English: code, comments, READMEs, specs, commit messages.
- Commits use the repo-local pseudonymous author (RebeLLM). Never commit with a personal
  name or e-mail address.
- No `Co-Authored-By` or other attribution trailers in commit messages.
- Always use Conventional Commits: `<type>(<scope>): <summary>`, e.g.
  `feat(relay): circuit reservations`, `fix(sidecar): history after a restart`. Types: feat,
  fix, docs, refactor, perf, test, build, chore.
