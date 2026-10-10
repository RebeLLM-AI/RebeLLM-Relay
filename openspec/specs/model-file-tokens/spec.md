# model-file-tokens Specification

## Purpose
Short-lived tokens the relay hands connected peers, which a file server checks before it serves binary model files.
## Requirements
### Requirement: Relay issues model file tokens
When the relay is started with a model file secret, it SHALL answer a request on the model
access protocol from any connected peer with a token: an expiry time one hour ahead, as unix
seconds, and the signature of that expiry with the secret in the form the file server
checks. Without a secret the relay SHALL NOT offer the protocol. The relay SHALL keep nothing
about issued tokens and SHALL log nothing about them.

#### Scenario: Connected peer asks
- **WHEN** a peer connected to a relay started with a secret opens the model access protocol
- **THEN** it receives an expiry about an hour ahead and a signature the file server accepts for that expiry

#### Scenario: No secret
- **WHEN** a peer opens the model access protocol on a relay started without a secret
- **THEN** the protocol is not supported and the peer goes on without a token

