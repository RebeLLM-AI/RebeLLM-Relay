//! The relay's counters and the admin page's snapshot of a running relay.

use std::collections::HashSet;

use serde_json::{json, Value};

use crate::admission::{ACCEPT_PENDING, ACCEPT_PER_SECOND, MAX_CONNECTIONS};
use crate::process::ProcessStats;
use crate::verbose::live_transport;

/// A reservation's life; browsers renew it 5 minutes before it ends.
pub const RESERVATION_TTL_MS: u64 = 30 * 60_000;

/// The relay's counts since start, kept in memory only.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Counters {
    pub connections_opened: u64,
    pub connections_closed: u64,
    pub refused: u64,
    pub reservations_granted: u64,
    pub reservations_refused: u64,
    pub relayed_streams: u64,
    pub relayed_bytes: u64,
    pub announces_accepted: u64,
    pub announces_rejected: u64,
    pub reports_accepted: u64,
    pub reports_rejected: u64,
    pub tokens: u64,
}

impl Counters {
    pub fn to_json(&self) -> Value {
        json!({
            "connectionsOpened": self.connections_opened,
            "connectionsClosed": self.connections_closed,
            "refused": self.refused,
            "reservationsGranted": self.reservations_granted,
            "reservationsRefused": self.reservations_refused,
            "relayedStreams": self.relayed_streams,
            "relayedBytes": self.relayed_bytes,
            "announcesAccepted": self.announces_accepted,
            "announcesRejected": self.announces_rejected,
            "reportsAccepted": self.reports_accepted,
            "reportsRejected": self.reports_rejected,
            "tokens": self.tokens,
        })
    }
}

/// An open connection as the snapshot and the sidecar see it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnInfo {
    pub id: String,
    pub peer: String,
    pub addr: String,
    pub opened_ms: u64,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct TopicCounts {
    pub subscribers: usize,
    pub mesh: usize,
}

pub struct LiveInput<'a> {
    pub now_ms: u64,
    pub started_ms: u64,
    pub peer_id: &'a str,
    pub statistics: bool,
    pub model_tokens: bool,
    pub connections: &'a [ConnInfo],
    pub reservations: usize,
    pub gossip_peers: usize,
    pub announce: TopicCounts,
    pub report: TopicCounts,
    /// The throttle's limit, refusals and tracked addresses; `None` when it is off.
    pub throttle: Option<(u64, u64, usize)>,
    pub counters: &'a Counters,
    pub process: ProcessStats,
    /// `None` without statistics, as the Node.js relay measured it only then.
    pub loop_lag_ms: Option<u64>,
}

/// Lower median of a non-empty list.
fn median(xs: &[f64]) -> f64 {
    let mut s = xs.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    s[(s.len() - 1) >> 1]
}

/// `Math.round` of a non-negative number.
fn round(x: f64) -> u64 {
    (x + 0.5).floor() as u64
}

/// Connections, reservations and limits, gossip, throttle, counters and process. The
/// announcing peers (`peers`) are the sidecar's to add.
pub fn relay_live(i: &LiveInput) -> Value {
    let mut by = [("ws", 0u64), ("wss", 0), ("circuit", 0), ("webrtc", 0), ("other", 0)];
    for c in i.connections {
        let t = live_transport(&c.addr);
        let slot = by.iter().position(|(name, _)| *name == t).unwrap_or(4);
        by[slot].1 += 1;
    }
    let ages: Vec<f64> = i
        .connections
        .iter()
        .map(|c| (i.now_ms.saturating_sub(c.opened_ms)) as f64 / 1000.0)
        .collect();
    let peers: HashSet<&str> = i.connections.iter().map(|c| c.peer.as_str()).collect();
    let topic = |t: TopicCounts| json!({ "subscribers": t.subscribers, "mesh": t.mesh });
    json!({
        "time": i.now_ms,
        "started": i.started_ms,
        "peerId": i.peer_id,
        "statistics": i.statistics,
        "modelTokens": i.model_tokens,
        "connections": {
            "open": i.connections.len(),
            "peers": peers.len(),
            "byTransport": { "ws": by[0].1, "wss": by[1].1, "circuit": by[2].1, "webrtc": by[3].1, "other": by[4].1 },
            "medianAgeSec": if ages.is_empty() { Value::Null } else { json!(round(median(&ages))) },
            "oldestAgeSec": if ages.is_empty() { Value::Null } else { json!(round(ages.iter().copied().fold(0.0, f64::max))) },
        },
        "reservations": i.reservations,
        "limits": {
            "connections": MAX_CONNECTIONS,
            "acceptPerSecond": ACCEPT_PER_SECOND,
            "pending": ACCEPT_PENDING,
            "reservations": MAX_CONNECTIONS,
            "reservationTtlMs": RESERVATION_TTL_MS,
            "newPeersPerHour": i.throttle.map_or(0, |t| t.0),
        },
        "gossip": { "peers": i.gossip_peers, "announce": topic(i.announce), "report": topic(i.report) },
        "throttle": match i.throttle {
            Some((_, refused, addresses)) => json!({ "refused": refused, "addresses": addresses }),
            None => Value::Null,
        },
        "counters": i.counters.to_json(),
        "process": {
            "uptimeSec": i.process.uptime_sec,
            "rssBytes": i.process.rss_bytes,
            "heapUsedBytes": i.process.heap_used_bytes,
            "heapTotalBytes": i.process.heap_peak_bytes,
            // V8 figures a Rust process does not have.
            "externalBytes": 0,
            "arrayBuffersBytes": 0,
            "cpuUserUs": i.process.cpu_user_us,
            "cpuSystemUs": i.process.cpu_system_us,
            "loopLagMs": i.loop_lag_ms,
        },
        "peers": Value::Null,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-09-25T10:00:00.000Z
    const NOW: u64 = 1_790_330_400_000;

    fn conn(peer: &str, addr: &str, age_sec: u64) -> ConnInfo {
        ConnInfo {
            id: format!("{peer}{age_sec}"),
            peer: peer.into(),
            addr: addr.into(),
            opened_ms: NOW - age_sec * 1000,
        }
    }

    #[test]
    fn relay_live_connections_by_transport_and_age_limits_gossip_throttle_counters_and_process() {
        let conns = [
            conn("a", "/ip4/1.2.3.4/tcp/1/ws", 10),
            conn("a", "/ip4/1.2.3.4/tcp/1/ws/p2p-circuit", 20),
            conn("b", "/dns4/x/tcp/443/wss", 30),
            conn("c", "/ip4/1.2.3.4/udp/1/webrtc-direct", 40),
            conn("d", "/ip4/1.2.3.4/tcp/1", 50),
        ];
        let counters = Counters {
            tokens: 4,
            ..Counters::default()
        };
        let process = ProcessStats {
            uptime_sec: 5,
            rss_bytes: 90,
            heap_used_bytes: 40,
            ..ProcessStats::default()
        };
        let input = LiveInput {
            now_ms: NOW,
            started_ms: NOW - 5000,
            peer_id: "RELAY",
            statistics: true,
            model_tokens: true,
            connections: &conns,
            reservations: 1,
            gossip_peers: 2,
            announce: TopicCounts {
                subscribers: 2,
                mesh: 1,
            },
            report: TopicCounts {
                subscribers: 1,
                mesh: 0,
            },
            throttle: Some((3, 0, 0)),
            counters: &counters,
            process,
            loop_lag_ms: None,
        };
        let live = relay_live(&input);
        assert_eq!(live["time"], NOW);
        assert_eq!(live["started"], NOW - 5000);
        assert_eq!(live["peerId"], "RELAY");
        assert_eq!(live["statistics"], true);
        assert_eq!(live["modelTokens"], true);
        assert_eq!(
            live["connections"],
            json!({
                "open": 5,
                "peers": 4,
                "byTransport": { "ws": 1, "wss": 1, "circuit": 1, "webrtc": 1, "other": 1 },
                "medianAgeSec": 30,
                "oldestAgeSec": 50,
            })
        );
        assert_eq!(live["reservations"], 1);
        assert_eq!(
            live["limits"],
            json!({
                "connections": 1000,
                "acceptPerSecond": 100,
                "pending": 256,
                "reservations": 1000,
                "reservationTtlMs": 30 * 60_000,
                "newPeersPerHour": 3,
            })
        );
        assert_eq!(
            live["gossip"],
            json!({ "peers": 2, "announce": { "subscribers": 2, "mesh": 1 }, "report": { "subscribers": 1, "mesh": 0 } })
        );
        assert_eq!(live["throttle"], json!({ "refused": 0, "addresses": 0 }));
        assert_eq!(live["counters"], counters.to_json());
        assert_eq!(live["counters"]["tokens"], 4);
        assert_eq!(live["process"]["loopLagMs"], Value::Null);
        assert_eq!(live["process"]["heapUsedBytes"], 40);
        assert_eq!(live["process"]["externalBytes"], 0);
        assert_eq!(live["process"]["uptimeSec"], 5);
        // The announcing peers come from the statistics, which the sidecar keeps.
        assert_eq!(live["peers"], Value::Null);

        // Without statistics, throttle or connections.
        let bare = relay_live(&LiveInput {
            statistics: false,
            connections: &[],
            throttle: None,
            started_ms: NOW,
            ..input
        });
        assert_eq!(bare["statistics"], false);
        assert_eq!(bare["peers"], Value::Null);
        assert_eq!(bare["throttle"], Value::Null);
        assert_eq!(bare["connections"]["medianAgeSec"], Value::Null);
        assert_eq!(bare["limits"]["newPeersPerHour"], 0);
    }

    #[test]
    fn the_counters_carry_the_names_the_admin_page_reads() {
        let keys: Vec<String> = Counters::default()
            .to_json()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(
            keys,
            [
                "connectionsOpened",
                "connectionsClosed",
                "refused",
                "reservationsGranted",
                "reservationsRefused",
                "relayedStreams",
                "relayedBytes",
                "announcesAccepted",
                "announcesRejected",
                "reportsAccepted",
                "reportsRejected",
                "tokens",
            ]
        );
    }
}
