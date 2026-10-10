# fetch-proxy Specification

## Purpose
The relay's optional page-fetch proxy for private networks: public web pages only, every hop checked.
## Requirements
### Requirement: Fetch proxy
The relay SHALL answer `GET /fetch?url=` only when a fetch port is set with `--fetch-port` or
`REBELLM_FETCH_PORT`. Where it answers it SHALL serve public `http` and `https` addresses
only, re-checking every redirect (at most five) and dialling the resolved address, forwarding
no credentials or other header of the client's request, passing text types only, capped at
2 MB and 15 s, and limited to 30 requests per minute per client address, taken from the first
`X-Forwarded-For` hop, else the socket. Its answers SHALL carry `X-Final-URL`,
`Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and a sandboxing
`Content-Security-Policy`; errors SHALL be JSON `{ "error": ... }` with the status of the
Node.js relay's proxy. A taken fetch port SHALL cost the proxy, not the relay.

#### Scenario: Private address
- **WHEN** the URL, or a redirect of it, resolves to a loopback, private or link-local address, in any IPv4 or IPv6 form
- **THEN** the proxy answers 403 without connecting

#### Scenario: Public page
- **WHEN** a public page of a text type is requested
- **THEN** the proxy answers 200 with the page, its content type and its final URL

#### Scenario: Not text, too large, too slow
- **WHEN** the page is an image, is larger than 2 MB, or does not arrive within 15 s
- **THEN** the proxy answers 415, 502 or 504

#### Scenario: Off by default
- **WHEN** the relay runs without a fetch port
- **THEN** nothing listens for `/fetch`

