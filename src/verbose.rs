//! The verbose log: one console line per connection, announce, reservation and relayed stream.

use crate::announce::Announce;
use crate::util::iso_time;

const B58: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// Base58btc, the text form of a peer id's multihash bytes.
pub fn base58(bytes: &[u8]) -> String {
    let mut digits: Vec<u8> = Vec::new();
    for &b in bytes {
        let mut carry = u32::from(b);
        for d in digits.iter_mut() {
            carry += u32::from(*d) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let zeros = bytes.iter().take_while(|b| **b == 0).count();
    std::iter::repeat_n('1', zeros)
        .chain(digits.iter().rev().map(|d| B58[*d as usize] as char))
        .collect()
}

/// True when `text` holds `/name` as a whole multiaddr component.
fn has_component(text: &str, name: &str) -> bool {
    text.match_indices(name).any(|(i, _)| {
        let end = i + name.len();
        end == text.len() || text.as_bytes()[end] == b'/'
    })
}

/// The transport a multiaddr names: circuit, wss, ws, else other; `-` without an address.
pub fn transport_of(addr: Option<&str>) -> &'static str {
    let a = addr.unwrap_or("");
    if a.contains("/p2p-circuit") {
        return "circuit";
    }
    // /tls/sni/<name>/ws is wss too: the name sits between.
    let sni = a.match_indices("/tls/sni/").any(|(i, _)| {
        let rest = &a[i + "/tls/sni/".len()..];
        rest.split_once('/')
            .is_some_and(|(name, tail)| !name.is_empty() && (tail == "ws" || tail.starts_with("ws/")))
    });
    if has_component(a, "/wss") || has_component(a, "/tls/ws") || sni {
        return "wss";
    }
    if has_component(a, "/ws") {
        return "ws";
    }
    if a.is_empty() {
        "-"
    } else {
        "other"
    }
}

/// The transport of the live snapshot: WebRTC addresses apart, the rest as the log names them.
pub fn live_transport(addr: &str) -> &'static str {
    if addr.contains("/webrtc") {
        "webrtc"
    } else {
        transport_of(Some(addr))
    }
}

/// The last eight characters of a peer id, `?` without one.
pub fn tail8(peer: Option<&str>) -> String {
    let p = peer.unwrap_or("?");
    let chars: Vec<char> = p.chars().collect();
    chars[chars.len().saturating_sub(8)..].iter().collect()
}

/// One verbose line: time, event, the peer id's last 8 characters, the transport, then details.
pub fn log_line(time_ms: u64, event: &str, peer: Option<&str>, transport: &str, extra: &str) -> String {
    let extra = if extra.is_empty() {
        String::new()
    } else {
        format!(" {extra}")
    };
    format!("{} {event} {} {transport}{extra}", iso_time(time_ms), tail8(peer))
}

/// The lines of the verbose log, one method per event; `print` gets each line.
pub struct Verbose<P: FnMut(String)> {
    print: P,
    now: Box<dyn Fn() -> u64 + Send>,
}

impl<P: FnMut(String)> Verbose<P> {
    pub fn new(print: P) -> Self {
        Self {
            print,
            now: Box::new(crate::util::now_ms),
        }
    }

    pub fn with_clock(mut self, now: impl Fn() -> u64 + Send + 'static) -> Self {
        self.now = Box::new(now);
        self
    }

    fn say(&mut self, event: &str, peer: Option<&str>, transport: &str, extra: &str) {
        let line = log_line((self.now)(), event, peer, transport, extra);
        (self.print)(line)
    }

    pub fn open(&mut self, peer: &str, addr: &str) {
        self.say("open", Some(peer), transport_of(Some(addr)), "")
    }

    pub fn close(&mut self, peer: &str, addr: &str) {
        self.say("close", Some(peer), transport_of(Some(addr)), "")
    }

    pub fn refused(&mut self, peer: &str, addr: &str) {
        self.say("refused", Some(peer), transport_of(Some(addr)), "new-peers")
    }

    /// `addr` is the address of the author's connection, when it has one here.
    pub fn announce(&mut self, from: Option<&str>, addr: Option<&str>, announce: &Announce) {
        let transport = if from.is_some() { transport_of(addr) } else { "-" };
        let summary = announce.summary().unwrap_or_else(|| "undecodable".into());
        self.say("announce", from, transport, &summary)
    }

    pub fn reserve(&mut self, peer: &str, addr: Option<&str>, granted: bool) {
        let event = if granted { "reserve" } else { "reserve-refused" };
        self.say(event, Some(peer), transport_of(addr), "")
    }

    /// A stream relayed to `peer`, dialed by `from`.
    pub fn stream(&mut self, peer: &str, addr: Option<&str>, from: Option<&str>) {
        self.say(
            "stream",
            Some(peer),
            transport_of(addr),
            &format!("from={}", tail8(from)),
        )
    }
}

#[cfg(test)]
mod tests {
    use base64::Engine;
    use serde_json::json;

    use super::*;

    // 2026-09-25T10:00:00.000Z
    const T: u64 = 1_790_330_400_000;
    const PEER: &str = "12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo";

    #[test]
    fn verbose_lines_time_event_the_last_8_characters_of_the_peer_id_transport_details() {
        assert_eq!(
            log_line(T, "open", Some(PEER), "wss", ""),
            "2026-09-25T10:00:00.000Z open kSCVe2Xo wss"
        );
        assert_eq!(
            log_line(T, "announce", Some(PEER), "ws", "model=qwen3-30b experts=12"),
            format!(
                "2026-09-25T10:00:00.000Z announce {} ws model=qwen3-30b experts=12",
                &PEER[PEER.len() - 8..]
            )
        );
        assert_eq!(transport_of(Some("/ip4/1.2.3.4/tcp/443/wss/p2p/X")), "wss");
        assert_eq!(
            transport_of(Some("/dns4/r.example/tcp/443/tls/sni/r.example/ws")),
            "wss"
        );
        assert_eq!(transport_of(Some("/ip4/1.2.3.4/tcp/443/tls/ws")), "wss");
        assert_eq!(transport_of(Some("/ip4/172.19.0.5/tcp/40000/ws")), "ws");
        assert_eq!(
            transport_of(Some("/ip4/1.2.3.4/tcp/443/wss/p2p/R/p2p-circuit/p2p/X")),
            "circuit"
        );
        assert_eq!(transport_of(Some("/ip4/1.2.3.4/udp/1/webrtc-direct")), "other");
        assert_eq!(transport_of(None), "-");
        assert_eq!(live_transport("/ip4/1.2.3.4/udp/1/webrtc-direct"), "webrtc");
        assert_eq!(base58(&[0, 0, 1]), "112");
        assert_eq!(base58(&[0x61, 0x62, 0x63]), "ZiCa");
    }

    #[test]
    fn the_verbose_log_prints_connections_announces_reservations_and_relayed_streams() {
        let mut lines: Vec<String> = Vec::new();
        {
            let mut v = Verbose::new(|l| lines.push(l)).with_clock(|| T);
            let ws = |port: u16| format!("/ip4/172.19.0.5/tcp/{port}/ws");
            v.open("peer-aaaaAAAA11", &ws(1));
            v.close("peer-aaaaAAAA11", &ws(1));
            let served = base64::engine::general_purpose::STANDARD.encode([3u8]);
            let data = serde_json::to_vec(&json!({ "model": "m", "served": served })).unwrap();
            v.announce(Some("peer-bbbbBBBB22"), Some(&ws(1)), &Announce::parse(&data));
            v.reserve("peer-ccccCCCC33", Some(&ws(2)), true);
            v.reserve("PEERREFUSEDxxxxx", Some(&ws(3)), false);
            // The dialing peer is named by the last characters of its id.
            v.stream("peer-ddddDDDD44", Some(&ws(4)), Some(&base58(&[0x61, 0x62, 0x63])));
            v.refused("peer-eeeeEEEE55", &ws(5));
            v.announce(None, None, &Announce::parse(b"junk"));
        }
        let at = "2026-09-25T10:00:00.000Z";
        assert_eq!(
            lines,
            vec![
                format!("{at} open aaAAAA11 ws"),
                format!("{at} close aaAAAA11 ws"),
                format!("{at} announce bbBBBB22 ws model=m experts=2"),
                format!("{at} reserve ccCCCC33 ws"),
                format!("{at} reserve-refused SEDxxxxx ws"),
                format!("{at} stream ddDDDD44 ws from=ZiCa"),
                format!("{at} refused eeEEEE55 ws new-peers"),
                format!("{at} announce ? - undecodable"),
            ]
        );
    }
}
