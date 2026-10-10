# The RebeLLM relay: the Rust binary and its Node.js statistics sidecar, behind a reverse proxy.
FROM rust:1-bookworm AS build

WORKDIR /src
COPY Cargo.toml Cargo.lock rustfmt.toml ./
COPY vendor ./vendor
COPY src ./src
RUN cargo build --release --locked --bins

# The sidecar needs Node.js; the previous relay image had the same base.
FROM node:24-bookworm-slim

WORKDIR /app
COPY --from=build /src/target/release/rebellm-relay /src/target/release/rebellm-relay-peer-id /usr/local/bin/
# The previous image's commands, `node index.ts` and `node peer-id.ts`, start the binaries.
COPY docker/package.json docker/index.ts docker/peer-id.ts docker/run.ts ./
# Every module: .dockerignore keeps the tests out.
COPY sidecar/ ./sidecar/
ENV REBELLM_SIDECAR=/app/sidecar/index.ts

# The key lives in a volume so the peer id, and with it every built app's relay address, survives;
# with --stats the daily statistics files and history.json go there too.
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
# 9090: libp2p over WebSocket; 9091: the page-fetch proxy (GET /fetch); 9092: the VRAM history
# (GET /stats/history) and the admin API (/admin/api/). The last two are reached only through the proxy.
EXPOSE 9090 9091 9092
CMD ["rebellm-relay", "--port", "9090", "--key", "/data/relay-key.bin"]
