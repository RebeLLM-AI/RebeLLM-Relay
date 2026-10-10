//! The libp2p node: WebSocket, Noise, Yamux, identify, ping, circuit relay v2 for WebRTC
//! signalling, gossipsub for announces and usage reports, and the model access protocol.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use futures::{AsyncWriteExt, StreamExt};
use libp2p::gossipsub::{self, IdentTopic, MessageAcceptance, MessageAuthenticity, MessageId, ValidationMode};
use libp2p::identity::Keypair;
use libp2p::swarm::{ConnectionId, NetworkBehaviour, SwarmEvent};
use libp2p::{connection_limits, identify, noise, ping, relay, yamux, Multiaddr, PeerId, StreamProtocol, Swarm};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

use crate::admission::{Admission, Refused, ACCEPT_PENDING, MAX_CONNECTIONS};
use crate::announce::{report_verdict, Announce, Verdict, ANNOUNCE_TOPIC, REPORT_TOPIC};
use crate::gate::IdentityThrottle;
use crate::live::{relay_live, ConnInfo, Counters, LiveInput, TopicCounts, RESERVATION_TTL_MS};
use crate::process::{process_stats, LagSampler};
use crate::token::{model_token, MODEL_ACCESS_PROTOCOL, MODEL_TOKEN_TTL_S};
use crate::util::{iso_time, now_ms};
use crate::verbose::Verbose;

/// The relay pings each peer this often, and drops one only after this silence: a page busy
/// with a prompt answers late, a browser that vanished never.
pub const RELAY_PEER_PING_MS: u64 = 10_000;
pub const RELAY_PEER_SILENT_MS: u64 = 45_000;
/// Relayed connections open at once through one peer's link, dialed by it or to it: one per
/// WebRTC dial while it signals.
pub const RELAY_STREAMS_PER_LINK: usize = 256;
/// A relayed connection's life and bytes: enough for WebRTC's offer, answer and candidates,
/// no expert traffic.
pub const SIGNAL_DURATION_MS: u64 = 2 * 60_000;
pub const SIGNAL_DATA_BYTES: u64 = 128 * 1024;
/// Largest gossip frame taken, as js-libp2p's gossipsub takes them.
const MAX_GOSSIP_BYTES: usize = 4 * 1024 * 1024;
/// Events waiting for the sidecar; past it they are dropped, not waited for.
pub const SIDECAR_QUEUE: usize = 4096;

pub struct RelayConfig {
    pub host: String,
    pub port: u16,
    pub key: Keypair,
    pub announce: Vec<String>,
    /// New identities per address and hour; 0 turns the throttle off.
    pub new_peers: u64,
    /// Whether loopback and private addresses are exempt from the throttle.
    pub exempt_private: bool,
    pub models_secret: Option<String>,
    pub peer_ping_ms: u64,
    pub peer_silent_ms: u64,
    pub streams_per_link: usize,
    pub reservation_ttl_ms: u64,
    pub statistics: bool,
    pub verbose: bool,
    /// Addresses of the machine's interfaces, for a relay that announces none.
    pub lan: Vec<String>,
}

impl RelayConfig {
    pub fn new(host: &str, port: u16, key: Keypair) -> Self {
        Self {
            host: host.to_string(),
            port,
            key,
            announce: Vec::new(),
            new_peers: crate::gate::NEW_PEERS_DEFAULT,
            exempt_private: true,
            models_secret: None,
            peer_ping_ms: RELAY_PEER_PING_MS,
            peer_silent_ms: RELAY_PEER_SILENT_MS,
            streams_per_link: RELAY_STREAMS_PER_LINK,
            reservation_ttl_ms: RESERVATION_TTL_MS,
            statistics: false,
            verbose: false,
            lan: Vec::new(),
        }
    }
}

/// What the rest of the process asks of the running relay.
pub enum Command {
    /// The live snapshot, without the announcing peers.
    Snapshot(oneshot::Sender<Value>),
    /// The peer id and every open connection, for a sidecar that starts.
    Hello(oneshot::Sender<Value>),
    /// Starts a new loop-lag window.
    ResetLag,
    Stop(oneshot::Sender<()>),
}

#[derive(NetworkBehaviour)]
struct Behaviour {
    admission: Admission,
    limits: connection_limits::Behaviour,
    identify: identify::Behaviour,
    ping: ping::Behaviour,
    relay: relay::Behaviour,
    gossipsub: gossipsub::Behaviour,
    stream: libp2p_stream::Behaviour,
}

/// A signed message's id as js-libp2p computes it: the author's public key in its protobuf
/// form, then the sequence number in 8 big-endian bytes. An Ed25519 or secp256k1 peer id is
/// an identity multihash of exactly that key.
pub fn js_message_id(source: Option<&PeerId>, sequence_number: Option<u64>) -> Vec<u8> {
    let mut id = match source.map(|p| p.to_bytes()) {
        Some(bytes) if bytes.len() > 2 && bytes[0] == 0 => bytes[2..].to_vec(),
        Some(bytes) => bytes,
        None => Vec::new(),
    };
    id.extend_from_slice(&sequence_number.unwrap_or(0).to_be_bytes());
    id
}

/// The addresses the relay tells peers it is reached at: the announced ones, else the listen
/// address, which for the unspecified host is loopback and every interface.
pub fn external_addresses(cfg: &RelayConfig) -> Vec<String> {
    if !cfg.announce.is_empty() {
        return cfg.announce.clone();
    }
    if cfg.host == "0.0.0.0" {
        return std::iter::once(format!("/ip4/127.0.0.1/tcp/{}/ws", cfg.port))
            .chain(cfg.lan.iter().cloned())
            .collect();
    }
    vec![format!("/ip4/{}/tcp/{}/ws", cfg.host, cfg.port)]
}

/// The circuit relay's limits: signalling only, and nothing counted per address, because
/// every peer arrives from the proxy's.
pub fn circuit_config(cfg: &RelayConfig, circuit_bytes: relay::CircuitBytes) -> relay::Config {
    relay::Config {
        max_reservations: MAX_CONNECTIONS as usize,
        reservation_duration: Duration::from_millis(cfg.reservation_ttl_ms),
        reservation_rate_limiters: Vec::new(),
        circuit_src_rate_limiters: Vec::new(),
        max_circuits: MAX_CONNECTIONS as usize * RELAY_STREAMS_PER_LINK,
        // The crate refuses above this number, so it allows one more.
        max_circuits_per_peer: cfg.streams_per_link.saturating_sub(1),
        max_circuit_duration: Duration::from_millis(SIGNAL_DURATION_MS),
        max_circuit_bytes: SIGNAL_DATA_BYTES,
        circuit_bytes: Some(circuit_bytes),
        ..relay::Config::default()
    }
}

/// Peers kept in the announce mesh, as the Node.js relay held them: js-libp2p accepts grafts
/// up to 12 and prunes above it, rust-libp2p prunes at its upper bound, so the bound is 13.
pub const MESH_PEERS: usize = 12;

fn gossip_config() -> Result<gossipsub::Config, BoxError> {
    Ok(gossipsub::ConfigBuilder::default()
        .validation_mode(ValidationMode::Strict)
        .validate_messages()
        .max_transmit_size(MAX_GOSSIP_BYTES)
        .mesh_n_low(4)
        .mesh_n(MESH_PEERS)
        .mesh_n_high(MESH_PEERS + 1)
        .message_id_fn(|m: &gossipsub::Message| MessageId::from(js_message_id(m.source.as_ref(), m.sequence_number)))
        .build()?)
}

/// Gossip scoring with no penalty for a shared address: every peer arrives from the proxy's,
/// and past ten the colocation penalty would graylist them all.
pub fn peer_score() -> gossipsub::PeerScoreParams {
    gossipsub::PeerScoreParams {
        ip_colocation_factor_weight: 0.0,
        ..Default::default()
    }
}

pub struct Relay {
    swarm: Swarm<Behaviour>,
    pub peer_id: String,
    pub started_ms: u64,
    statistics: bool,
    model_tokens: bool,
    throttle: Option<Arc<Mutex<IdentityThrottle>>>,
    counters: Counters,
    tokens: Arc<AtomicU64>,
    connections: HashMap<ConnectionId, ConnInfo>,
    /// Connected peers that turned out not to speak gossipsub.
    no_gossip: HashSet<PeerId>,
    lag: LagSampler,
    verbose: Option<Verbose<fn(String)>>,
    relayed_rx: mpsc::UnboundedReceiver<(PeerId, PeerId, u64)>,
    /// Bytes relayed since the last flush to the sidecar, per reserving and dialing peer.
    relayed: HashMap<(PeerId, PeerId), u64>,
    sidecar: Option<mpsc::Sender<Value>>,
    /// Events the sidecar's queue did not take.
    pub dropped: u64,
    announce: IdentTopic,
    report: IdentTopic,
}

type BoxError = Box<dyn std::error::Error + Send + Sync>;

fn print_line(line: String) {
    println!("{line}")
}

impl Relay {
    /// Builds the node and listens; fails when the address cannot be bound.
    pub async fn start(cfg: RelayConfig, sidecar: Option<mpsc::Sender<Value>>) -> Result<Self, BoxError> {
        let started_ms = now_ms();
        let throttle = (cfg.new_peers > 0).then(|| {
            Arc::new(Mutex::new(
                IdentityThrottle::new(cfg.new_peers).exempt_private(cfg.exempt_private),
            ))
        });
        let (relayed_tx, relayed_rx) = mpsc::unbounded_channel();
        let external = external_addresses(&cfg);
        let admission = Admission::new(throttle.clone());
        let ping = Duration::from_millis(cfg.peer_ping_ms);
        let silent = Duration::from_millis(cfg.peer_silent_ms);
        let relay_cfg = circuit_config(
            &cfg,
            Arc::new(move |src, dst, n| {
                let _ = relayed_tx.send((src, dst, n));
            }),
        );
        let mut swarm = libp2p::SwarmBuilder::with_existing_identity(cfg.key.clone())
            .with_tokio()
            .with_websocket(noise::Config::new, yamux::Config::default)
            .await?
            .with_behaviour(|key| -> Result<Behaviour, BoxError> {
                let mut gossipsub =
                    gossipsub::Behaviour::new(MessageAuthenticity::Signed(key.clone()), gossip_config()?)?;
                gossipsub.with_peer_score(peer_score(), gossipsub::PeerScoreThresholds::default())?;
                let mut relay = relay::Behaviour::new(key.public().to_peer_id(), relay_cfg);
                // Not left to the crate: it offers the hop protocol only with a confirmed external address.
                relay.set_status(Some(relay::Status::Enable));
                Ok(Behaviour {
                    admission,
                    limits: connection_limits::Behaviour::new(
                        connection_limits::ConnectionLimits::default()
                            .with_max_established(Some(MAX_CONNECTIONS))
                            .with_max_pending_incoming(Some(ACCEPT_PENDING)),
                    ),
                    identify: identify::Behaviour::new(
                        identify::Config::new("ipfs/0.1.0".into(), key.public())
                            .with_agent_version(format!("rebellm-relay/{}", env!("CARGO_PKG_VERSION")))
                            // Peers learn the announced addresses, not the container's own.
                            .with_hide_listen_addrs(true),
                    ),
                    ping: ping::Behaviour::new(ping::Config::new().with_interval(ping).with_timeout(silent)),
                    relay,
                    gossipsub,
                    stream: libp2p_stream::Behaviour::new(),
                })
            })?
            // A peer that only holds its link open is not idle.
            .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(10 * 365 * 86_400)))
            .build();
        let listen: Multiaddr = format!("/ip4/{}/tcp/{}/ws", cfg.host, cfg.port).parse()?;
        swarm.listen_on(listen)?;
        // A taken port must stop the start, not surface later.
        loop {
            match swarm.select_next_some().await {
                SwarmEvent::NewListenAddr { .. } => break,
                SwarmEvent::ListenerClosed { reason: Err(e), .. } => return Err(e.into()),
                SwarmEvent::ListenerError { error, .. } => return Err(error.into()),
                _ => {}
            }
        }
        for a in &external {
            swarm.add_external_address(a.parse()?);
        }
        let announce = IdentTopic::new(ANNOUNCE_TOPIC);
        let report = IdentTopic::new(REPORT_TOPIC);
        swarm.behaviour_mut().gossipsub.subscribe(&announce)?;
        swarm.behaviour_mut().gossipsub.subscribe(&report)?;
        let tokens = Arc::new(AtomicU64::new(0));
        if let Some(secret) = cfg.models_secret.clone() {
            // The link is Noise-authenticated and admitted by the gate: any connected peer is
            // on this network. One line per stream, nothing kept, nothing logged.
            let mut incoming = swarm
                .behaviour()
                .stream
                .new_control()
                .accept(StreamProtocol::new(MODEL_ACCESS_PROTOCOL))?;
            let issued = tokens.clone();
            tokio::spawn(async move {
                while let Some((_, mut stream)) = incoming.next().await {
                    issued.fetch_add(1, Ordering::Relaxed);
                    let line = format!("{}\n", model_token(&secret, now_ms(), MODEL_TOKEN_TTL_S).to_json());
                    tokio::spawn(async move {
                        if stream.write_all(line.as_bytes()).await.is_ok() {
                            let _ = stream.close().await;
                        }
                    });
                }
            });
        }
        Ok(Self {
            peer_id: swarm.local_peer_id().to_string(),
            swarm,
            started_ms,
            statistics: cfg.statistics,
            model_tokens: cfg.models_secret.is_some(),
            throttle,
            counters: Counters::default(),
            tokens,
            connections: HashMap::new(),
            no_gossip: HashSet::new(),
            lag: LagSampler::start(),
            verbose: cfg.verbose.then(|| Verbose::new(print_line as fn(String))),
            relayed_rx,
            relayed: HashMap::new(),
            sidecar,
            dropped: 0,
            announce,
            report,
        })
    }

    /// The throttle's limit, or `None` when it is off.
    pub fn new_peers_limit(&self) -> Option<u64> {
        self.throttle
            .as_ref()
            .map(|t| t.lock().unwrap_or_else(|e| e.into_inner()).limit)
    }

    pub fn model_tokens(&self) -> bool {
        self.model_tokens
    }

    fn emit(&mut self, event: Value) {
        if let Some(tx) = &self.sidecar {
            if tx.try_send(event).is_err() {
                self.dropped += 1;
            }
        }
    }

    fn addr_of(&self, peer: &PeerId) -> Option<String> {
        let peer = peer.to_string();
        self.connections
            .values()
            .find(|c| c.peer == peer)
            .map(|c| c.addr.clone())
    }

    fn topic_counts(&self, topic: &IdentTopic) -> TopicCounts {
        let hash = topic.hash();
        let gossip = &self.swarm.behaviour().gossipsub;
        TopicCounts {
            subscribers: gossip.all_peers().filter(|(_, topics)| topics.contains(&&hash)).count(),
            mesh: gossip.mesh_peers(&hash).count(),
        }
    }

    fn connection_list(&self) -> Vec<ConnInfo> {
        self.connections.values().cloned().collect()
    }

    pub fn snapshot(&mut self) -> Value {
        self.counters.tokens = self.tokens.load(Ordering::Relaxed);
        let throttle = self.throttle.as_ref().map(|t| {
            let mut t = t.lock().unwrap_or_else(|e| e.into_inner());
            (t.limit, t.refused, t.size())
        });
        let connections = self.connection_list();
        relay_live(&LiveInput {
            now_ms: now_ms(),
            started_ms: self.started_ms,
            peer_id: &self.peer_id,
            statistics: self.statistics,
            model_tokens: self.model_tokens,
            connections: &connections,
            reservations: self.swarm.behaviour().relay.reservations(),
            // A connected peer that does not speak gossipsub is not a gossip peer.
            gossip_peers: self
                .swarm
                .behaviour()
                .gossipsub
                .all_peers()
                .filter(|(peer, _)| !self.no_gossip.contains(peer))
                .count(),
            announce: self.topic_counts(&self.announce),
            report: self.topic_counts(&self.report),
            throttle,
            counters: &self.counters,
            process: process_stats(self.started_ms),
            loop_lag_ms: self.statistics.then(|| self.lag.p99_ms()),
        })
    }

    fn conn_json(c: &ConnInfo) -> Value {
        json!({ "id": c.id, "peer": c.peer, "addr": c.addr, "open": c.opened_ms })
    }

    fn hello(&self) -> Value {
        let connections: Vec<Value> = self.connections.values().map(Self::conn_json).collect();
        json!({ "peerId": self.peer_id, "started": self.started_ms, "connections": connections })
    }

    /// The status line: peers, announce subscribers and, once any, the refusals.
    fn status(&self) -> String {
        let refused = self
            .throttle
            .as_ref()
            .map_or(0, |t| t.lock().unwrap_or_else(|e| e.into_inner()).refused);
        let refused = if refused > 0 {
            format!(" refused={refused}")
        } else {
            String::new()
        };
        format!(
            "peers={} topic={}{refused}",
            self.connections.len(),
            self.topic_counts(&self.announce).subscribers
        )
    }

    fn on_gossip(&mut self, propagation_source: PeerId, message_id: MessageId, message: gossipsub::Message) {
        let from = message.source.map(|p| p.to_string());
        let acceptance = if message.topic == self.announce.hash() {
            // Undecodable announces are dropped here instead of being forwarded to every browser.
            let announce = Announce::parse(&message.data);
            if announce.verdict == Verdict::Accept {
                self.counters.announces_accepted += 1;
                let addr = message.source.and_then(|p| self.addr_of(&p));
                if let Some(v) = self.verbose.as_mut() {
                    v.announce(from.as_deref(), addr.as_deref(), &announce);
                }
                if let Some(from) = &from {
                    let data = base64::engine::general_purpose::STANDARD.encode(&message.data);
                    self.emit(json!({ "t": "announce", "peer": from, "data": data }));
                }
                MessageAcceptance::Accept
            } else {
                self.counters.announces_rejected += 1;
                MessageAcceptance::Reject
            }
        } else if message.topic == self.report.hash() {
            let via = propagation_source.to_string();
            if report_verdict(&message.data, from.as_deref(), Some(&via)) == Verdict::Accept {
                self.counters.reports_accepted += 1;
                let data = base64::engine::general_purpose::STANDARD.encode(&message.data);
                self.emit(json!({ "t": "report", "peer": via, "data": data }));
                // Recorded, then ignored: a report is for the relay operator, not for a peer
                // that subscribes to the topic.
                MessageAcceptance::Ignore
            } else {
                self.counters.reports_rejected += 1;
                MessageAcceptance::Reject
            }
        } else {
            MessageAcceptance::Ignore
        };
        self.swarm.behaviour_mut().gossipsub.report_message_validation_result(
            &message_id,
            &propagation_source,
            acceptance,
        );
    }

    fn on_relay(&mut self, event: relay::Event) {
        match event {
            relay::Event::ReservationReqAccepted { src_peer_id, .. } => {
                self.counters.reservations_granted += 1;
                let addr = self.addr_of(&src_peer_id);
                if let Some(v) = self.verbose.as_mut() {
                    v.reserve(&src_peer_id.to_string(), addr.as_deref(), true);
                }
            }
            relay::Event::ReservationReqDenied { src_peer_id, .. } => {
                self.counters.reservations_refused += 1;
                let addr = self.addr_of(&src_peer_id);
                if let Some(v) = self.verbose.as_mut() {
                    v.reserve(&src_peer_id.to_string(), addr.as_deref(), false);
                }
            }
            relay::Event::CircuitReqAccepted {
                src_peer_id,
                dst_peer_id,
            } => {
                self.counters.relayed_streams += 1;
                let addr = self.addr_of(&dst_peer_id);
                if let Some(v) = self.verbose.as_mut() {
                    v.stream(
                        &dst_peer_id.to_string(),
                        addr.as_deref(),
                        Some(&src_peer_id.to_string()),
                    );
                }
            }
            _ => {}
        }
    }

    fn on_swarm(&mut self, event: SwarmEvent<BehaviourEvent>) {
        match event {
            SwarmEvent::ConnectionEstablished {
                peer_id,
                connection_id,
                endpoint,
                ..
            } => {
                self.counters.connections_opened += 1;
                let info = ConnInfo {
                    id: connection_id.to_string(),
                    peer: peer_id.to_string(),
                    addr: endpoint.get_remote_address().to_string(),
                    opened_ms: now_ms(),
                };
                if let Some(v) = self.verbose.as_mut() {
                    v.open(&info.peer, &info.addr);
                }
                // A browser that redials after a silent drop leaves its dead connection here, and
                // gossip would keep its stream to the browser on it; the newest one replaces it.
                let stale: Vec<ConnectionId> = self
                    .connections
                    .iter()
                    .filter(|(_, c)| c.peer == info.peer)
                    .map(|(id, _)| *id)
                    .collect();
                for id in stale {
                    self.swarm.close_connection(id);
                }
                self.emit(json!({ "t": "open", "conn": Self::conn_json(&info) }));
                self.connections.insert(connection_id, info);
            }
            SwarmEvent::ConnectionClosed {
                peer_id,
                connection_id,
                num_established,
                ..
            } => {
                self.counters.connections_closed += 1;
                if num_established == 0 {
                    self.no_gossip.remove(&peer_id);
                }
                if let Some(info) = self.connections.remove(&connection_id) {
                    if let Some(v) = self.verbose.as_mut() {
                        v.close(&info.peer, &info.addr);
                    }
                    self.emit(json!({ "t": "close", "id": info.id, "peer": info.peer }));
                }
            }
            SwarmEvent::Behaviour(BehaviourEvent::Admission(Refused { peer, addr })) => {
                self.counters.refused += 1;
                if let Some(v) = self.verbose.as_mut() {
                    v.refused(&peer, &addr);
                }
            }
            SwarmEvent::Behaviour(BehaviourEvent::Ping(ping::Event { connection, result, .. })) => {
                // A peer without the ping protocol is not a silent one.
                if matches!(result, Err(ping::Failure::Timeout | ping::Failure::Other { .. })) {
                    self.swarm.close_connection(connection);
                }
            }
            SwarmEvent::Behaviour(BehaviourEvent::Gossipsub(gossipsub::Event::Message {
                propagation_source,
                message_id,
                message,
            })) => self.on_gossip(propagation_source, message_id, message),
            SwarmEvent::Behaviour(BehaviourEvent::Gossipsub(gossipsub::Event::GossipsubNotSupported { peer_id })) => {
                self.no_gossip.insert(peer_id);
            }
            SwarmEvent::Behaviour(BehaviourEvent::Relay(event)) => self.on_relay(event),
            _ => {}
        }
    }

    fn flush_relayed(&mut self) {
        let relayed: Vec<((PeerId, PeerId), u64)> = self.relayed.drain().collect();
        for ((dst, src), bytes) in relayed {
            self.emit(json!({ "t": "relayed", "peers": [dst.to_string(), src.to_string()], "bytes": bytes }));
        }
    }

    /// Serves peers until a `Stop` command, or until every command sender is gone.
    pub async fn run(mut self, mut commands: mpsc::Receiver<Command>) {
        let mut status = tokio::time::interval(Duration::from_secs(10));
        let mut flush = tokio::time::interval(Duration::from_secs(1));
        let mut last = String::new();
        loop {
            tokio::select! {
                event = self.swarm.select_next_some() => self.on_swarm(event),
                Some((src, dst, n)) = self.relayed_rx.recv() => {
                    self.counters.relayed_bytes += n;
                    if self.sidecar.is_some() {
                        *self.relayed.entry((dst, src)).or_insert(0) += n;
                    }
                }
                _ = flush.tick() => self.flush_relayed(),
                _ = status.tick() => {
                    let s = self.status();
                    if s != last {
                        println!("{} {s}", iso_time(now_ms()));
                    }
                    last = s;
                }
                command = commands.recv() => match command {
                    Some(Command::Snapshot(reply)) => {
                        let _ = reply.send(self.snapshot());
                    }
                    Some(Command::Hello(reply)) => {
                        let _ = reply.send(self.hello());
                    }
                    Some(Command::ResetLag) => self.lag.reset(),
                    Some(Command::Stop(done)) => {
                        drop(self);
                        let _ = done.send(());
                        return;
                    }
                    None => return,
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_message_id_is_the_authors_protobuf_public_key_and_the_sequence_number_as_js_libp2p_has_it() {
        let key = Keypair::generate_ed25519();
        let peer = key.public().to_peer_id();
        let mut want = key.public().encode_protobuf();
        want.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0x01, 0x02]);
        assert_eq!(js_message_id(Some(&peer), Some(0x0102)), want);
        assert_eq!(want.len(), 36 + 8);
        // A different sequence number is a different message.
        assert_ne!(js_message_id(Some(&peer), Some(0x0103)), want);
    }

    #[test]
    fn a_relayed_connection_is_for_signalling_only_and_the_limits_are_the_previous_relays() {
        assert_eq!(SIGNAL_DURATION_MS, 120_000);
        assert_eq!(SIGNAL_DATA_BYTES, 131_072);
        assert_eq!(RELAY_STREAMS_PER_LINK, 256);
        assert_eq!(RESERVATION_TTL_MS, 30 * 60_000);
        // A peer is pinged every 10 s and dropped only after 45 s without an answer.
        assert_eq!((RELAY_PEER_PING_MS, RELAY_PEER_SILENT_MS), (10_000, 45_000));
    }

    #[test]
    fn the_circuit_limits_256_through_each_link_1000_reservations_of_30_minutes_2_minutes_and_128_kib() {
        let mut cfg = RelayConfig::new("127.0.0.1", 4001, Keypair::generate_ed25519());
        let limits = circuit_config(&cfg, Arc::new(|_, _, _| {}));
        // The crate refuses a circuit above its number: 255 lets 256 through.
        assert_eq!(limits.max_circuits_per_peer + 1, 256);
        assert_eq!(limits.max_reservations, 1000);
        assert_eq!(limits.reservation_duration, Duration::from_secs(30 * 60));
        assert_eq!(limits.max_circuit_duration, Duration::from_secs(120));
        assert_eq!(limits.max_circuit_bytes, 131_072);
        // Nothing is limited per address: behind the proxy all peers share one.
        assert!(limits.reservation_rate_limiters.is_empty() && limits.circuit_src_rate_limiters.is_empty());
        assert!(limits.circuit_bytes.is_some());
        cfg.streams_per_link = 1;
        cfg.reservation_ttl_ms = 4000;
        let one = circuit_config(&cfg, Arc::new(|_, _, _| {}));
        assert_eq!(one.max_circuits_per_peer, 0);
        assert_eq!(one.reservation_duration, Duration::from_secs(4));
    }

    #[test]
    fn gossip_scores_no_peer_down_for_its_address_and_holds_twelve_peers_in_the_mesh() {
        let score = peer_score();
        assert_eq!(score.ip_colocation_factor_weight, 0.0);
        assert!(score.validate().is_ok());
        let gossip = gossip_config().unwrap();
        assert_eq!(
            (gossip.mesh_n_low(), gossip.mesh_n(), gossip.mesh_n_high()),
            (4, 12, 13)
        );
        assert_eq!(gossip.max_transmit_size(), 4 * 1024 * 1024);
        assert!(gossip.validate_messages());
    }

    #[test]
    fn peers_are_told_the_announced_addresses_else_the_listen_address() {
        let mut cfg = RelayConfig::new("127.0.0.1", 4001, Keypair::generate_ed25519());
        assert_eq!(external_addresses(&cfg), vec!["/ip4/127.0.0.1/tcp/4001/ws"]);
        cfg.host = "0.0.0.0".into();
        cfg.lan = vec!["/ip4/192.168.1.5/tcp/4001/ws".into()];
        assert_eq!(
            external_addresses(&cfg),
            vec!["/ip4/127.0.0.1/tcp/4001/ws", "/ip4/192.168.1.5/tcp/4001/ws"]
        );
        cfg.announce = vec!["/dns4/r.example/tcp/443/wss".into()];
        assert_eq!(external_addresses(&cfg), vec!["/dns4/r.example/tcp/443/wss"]);
    }

    #[tokio::test]
    async fn starts_on_a_port_with_a_key_and_stops_and_a_taken_port_fails() {
        let key = Keypair::generate_ed25519();
        let free = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let relay = Relay::start(RelayConfig::new("127.0.0.1", free, key.clone()), None)
            .await
            .unwrap();
        assert_eq!(relay.peer_id, key.public().to_peer_id().to_string());
        assert_eq!(relay.new_peers_limit(), Some(5));
        assert!(!relay.model_tokens());
        // The listen socket is bound: a second relay on it does not start. (Windows lets a
        // second socket share a port bound with SO_REUSEADDR, which the TCP transport sets.)
        #[cfg(unix)]
        assert!(
            Relay::start(RelayConfig::new("127.0.0.1", free, Keypair::generate_ed25519()), None)
                .await
                .is_err()
        );
        let (tx, rx) = mpsc::channel(4);
        let running = tokio::spawn(relay.run(rx));
        let (reply, snapshot) = oneshot::channel();
        tx.send(Command::Snapshot(reply)).await.ok().unwrap();
        let live = snapshot.await.unwrap();
        assert_eq!(live["connections"]["open"], 0);
        assert_eq!(live["statistics"], false);
        assert_eq!(live["process"]["loopLagMs"], Value::Null);
        assert_eq!(live["limits"]["newPeersPerHour"], 5);
        let (done, stopped) = oneshot::channel();
        tx.send(Command::Stop(done)).await.ok().unwrap();
        stopped.await.unwrap();
        running.await.unwrap();
    }
}
