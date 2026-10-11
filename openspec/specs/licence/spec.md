# licence Specification

## Purpose
TBD - created by archiving change license-polyform-strict. Update Purpose after archive.
## Requirements
### Requirement: Licence
The repository SHALL be licensed under PolyForm Strict 1.0.0: `LICENSE` SHALL hold that
licence's text with a required notice naming RebeLLM as copyright holder and no company, the
`license` field of `Cargo.toml` and of every `package.json` SHALL be `PolyForm-Strict-1.0.0`,
and `LICENSE` SHALL state that `vendor/` keeps its own MIT licence.

#### Scenario: Licence fields
- **WHEN** `Cargo.toml` or any `package.json` is read
- **THEN** its `license` field is `PolyForm-Strict-1.0.0`

#### Scenario: No company named
- **WHEN** `LICENSE` is read
- **THEN** it is the PolyForm Strict 1.0.0 text, its required notice names RebeLLM, and it names no company

