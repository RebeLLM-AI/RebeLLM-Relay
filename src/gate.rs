//! New peer identities per remote address, so a key is not free: a banned node cannot come
//! back at once under a fresh key, and one machine cannot flood the network with identities.

use std::collections::{BTreeMap, HashMap};

use base64::Engine;
use sha2::{Digest, Sha256};

use crate::netaddr::is_blocked_address;

pub const NEW_PEERS_DEFAULT: u64 = 5;
pub const NEW_PEERS_WINDOW_MS: u64 = 60 * 60_000;

/// The IPv4 address, or the IPv6 /64 prefix, of a multiaddr; `None` when it names neither.
pub fn address_key(multiaddr: &str) -> Option<String> {
    if let Some(rest) = multiaddr.strip_prefix("/ip4/") {
        return Some(rest.split('/').next().unwrap_or("").to_string());
    }
    let rest = multiaddr.strip_prefix("/ip6/")?;
    let address = rest.split('/').next().unwrap_or("").to_ascii_lowercase();
    let (head, tail) = address.split_once("::").unwrap_or((&address, ""));
    let groups = |s: &str| -> Vec<String> {
        if s.is_empty() {
            Vec::new()
        } else {
            s.split(':').map(str::to_string).collect()
        }
    };
    let (head, tail) = (groups(head), groups(tail));
    let fill = 8usize.saturating_sub(head.len() + tail.len());
    let full: Vec<String> = head
        .into_iter()
        .chain(std::iter::repeat_n("0".to_string(), fill))
        .chain(tail)
        .collect();
    Some(full.into_iter().take(4).collect::<Vec<_>>().join(":"))
}

struct Entry {
    /// Position in `order`: the time order of each address's newest identity.
    seq: u64,
    newest: u64,
    ids: HashMap<String, u64>,
}

/// Admits at most `limit` distinct peer ids per address within `window_ms`. Addresses live only
/// as salted hashes in memory; the salt is drawn per instance, so nothing outlives the process
/// or can be joined with anything else. Loopback and private addresses are exempt unless asked,
/// because behind a proxy every peer arrives from the same one.
pub struct IdentityThrottle {
    /// Connections refused so far.
    pub refused: u64,
    pub limit: u64,
    pub window_ms: u64,
    pub exempt_private: bool,
    salt: [u8; 16],
    now: Box<dyn Fn() -> u64 + Send>,
    seen: HashMap<String, Entry>,
    order: BTreeMap<u64, String>,
    next_seq: u64,
}

impl IdentityThrottle {
    pub fn new(limit: u64) -> Self {
        Self {
            refused: 0,
            limit,
            window_ms: NEW_PEERS_WINDOW_MS,
            exempt_private: true,
            salt: rand::random(),
            now: Box::new(crate::util::now_ms),
            seen: HashMap::new(),
            order: BTreeMap::new(),
            next_seq: 0,
        }
    }

    pub fn exempt_private(mut self, exempt: bool) -> Self {
        self.exempt_private = exempt;
        self
    }

    pub fn with_salt(mut self, salt: [u8; 16]) -> Self {
        self.salt = salt;
        self
    }

    pub fn with_clock(mut self, now: impl Fn() -> u64 + Send + 'static) -> Self {
        self.now = Box::new(now);
        self
    }

    /// The salted hash an address is kept under.
    pub fn hash(&self, address: &str) -> String {
        let digest = Sha256::new().chain_update(self.salt).chain_update(address).finalize();
        base64::engine::general_purpose::STANDARD.encode(digest)
    }

    /// True to admit the connection; false counts a refusal.
    pub fn admit(&mut self, remote_addr: &str, peer_id: &str) -> bool {
        let Some(address) = address_key(remote_addr) else {
            return true;
        };
        if self.exempt_private && is_blocked_address(&address) {
            return true;
        }
        let t = (self.now)();
        self.sweep(t);
        let key = self.hash(&address);
        let window = self.window_ms;
        // After the sweep a stored address still has an identity inside the window.
        if let Some(entry) = self.seen.get_mut(&key) {
            entry.ids.retain(|_, at| t - *at < window);
            if entry.ids.contains_key(peer_id) {
                return true;
            }
        }
        let known = self.seen.get(&key).map_or(0, |e| e.ids.len() as u64);
        // A refusal stores nothing, so no empty entry is ever kept.
        if known >= self.limit {
            self.refused += 1;
            return false;
        }
        let seq = self.next_seq;
        self.next_seq += 1;
        let entry = self.seen.entry(key.clone()).or_insert_with(|| Entry {
            seq,
            newest: t,
            ids: HashMap::new(),
        });
        entry.ids.insert(peer_id.to_string(), t);
        entry.newest = t;
        // Moved to the end, so the order stays that of each address's newest identity.
        self.order.remove(&entry.seq);
        entry.seq = seq;
        self.order.insert(seq, key);
        true
    }

    /// Forgets the addresses whose newest identity left the window; they are a prefix of the order.
    fn sweep(&mut self, t: u64) {
        while let Some((seq, key)) = self.order.first_key_value().map(|(s, k)| (*s, k.clone())) {
            if self.seen.get(&key).is_some_and(|e| t - e.newest < self.window_ms) {
                break;
            }
            self.order.remove(&seq);
            self.seen.remove(&key);
        }
    }

    /// Addresses with a counted identity in the window.
    pub fn size(&mut self) -> usize {
        let t = (self.now)();
        self.sweep(t);
        self.seen.len()
    }

    /// Address entries held in memory right now, before any sweep.
    pub fn tracked(&self) -> usize {
        self.seen.len()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    use super::*;

    const PUB: &str = "/ip4/203.0.114.7/tcp/51000/ws";

    fn ids(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("peer{i}")).collect()
    }

    struct Clock(Arc<AtomicU64>);

    impl Clock {
        fn new() -> Self {
            Self(Arc::new(AtomicU64::new(1_000_000)))
        }
        fn tick(&self, ms: u64) {
            self.0.fetch_add(ms, Ordering::SeqCst);
        }
        fn throttle(&self, limit: u64) -> IdentityThrottle {
            let t = self.0.clone();
            IdentityThrottle::new(limit)
                .exempt_private(false)
                .with_clock(move || t.load(Ordering::SeqCst))
        }
    }

    #[test]
    fn address_key_the_ipv4_address_the_ipv6_64_prefix_nothing_for_other_multiaddrs() {
        assert_eq!(address_key(PUB).as_deref(), Some("203.0.114.7"));
        assert_eq!(
            address_key("/ip6/2001:db8:1:2:3:4:5:6/tcp/1/ws").as_deref(),
            Some("2001:db8:1:2")
        );
        assert_eq!(address_key("/ip6/2001:db8::1/tcp/1").as_deref(), Some("2001:db8:0:0"));
        assert_eq!(address_key("/ip6/::1/tcp/1").as_deref(), Some("0:0:0:0"));
        assert_eq!(address_key("/dns4/relay.example/tcp/443/wss"), None);
        assert_eq!(address_key(""), None);
    }

    #[test]
    fn admits_five_new_identities_per_address_and_hour_then_refuses_a_known_id_reconnects_freely() {
        let mut t = IdentityThrottle::new(NEW_PEERS_DEFAULT).exempt_private(false);
        assert_eq!(t.limit, 5);
        let peers = ids(6);
        for id in &peers[..5] {
            assert!(t.admit(PUB, id));
        }
        assert!(!t.admit(PUB, &peers[5]));
        assert!(!t.admit(PUB, &peers[5]));
        assert_eq!(t.refused, 2);
        // Known ids, also on another port of the same address, count nothing.
        assert!(t.admit(PUB, &peers[0]));
        assert!(t.admit("/ip4/203.0.114.7/tcp/9/ws", &peers[4]));
        assert_eq!(t.refused, 2);
        // Another address has its own budget.
        assert!(t.admit("/ip4/198.51.99.1/tcp/1/ws", &peers[5]));
        assert_eq!(t.size(), 2);
    }

    #[test]
    fn the_window_slides_an_identity_counted_an_hour_ago_frees_its_slot() {
        let c = Clock::new();
        let mut t = c.throttle(2);
        assert!(t.admit(PUB, "a"));
        c.tick(10 * 60_000);
        assert!(t.admit(PUB, "b"));
        assert!(!t.admit(PUB, "c"));
        c.tick(NEW_PEERS_WINDOW_MS - 10 * 60_000);
        // 'a' is an hour old now, 'b' is not.
        assert!(t.admit(PUB, "c"));
        assert!(!t.admit(PUB, "d"));
        c.tick(NEW_PEERS_WINDOW_MS);
        assert!(t.admit(PUB, "d"));
        assert_eq!(t.size(), 1);
        assert_eq!(t.refused, 2);
    }

    #[test]
    fn an_address_whose_identities_all_left_the_window_is_forgotten_whether_it_comes_back_or_not() {
        let c = Clock::new();
        let mut t = c.throttle(2);
        let other = "/ip4/198.51.99.1/tcp/1/ws";
        assert!(t.admit(PUB, "a"));
        assert!(t.admit(PUB, "b"));
        assert!(!t.admit(PUB, "c"));
        c.tick(10 * 60_000);
        assert!(t.admit(other, "x"));
        assert_eq!(t.tracked(), 2);
        c.tick(NEW_PEERS_WINDOW_MS - 10 * 60_000);
        // PUB's newest identity is an hour old: gone from the count and from memory.
        assert_eq!(t.size(), 1);
        assert_eq!(t.tracked(), 1);
        c.tick(10 * 60_000);
        // An admit elsewhere sweeps too, without a size call.
        assert!(t.admit("/ip4/192.0.3.9/tcp/1/ws", "y"));
        assert_eq!(t.tracked(), 1);
        // PUB starts over: two new identities fit again, the third does not.
        assert!(t.admit(PUB, "c"));
        assert!(t.admit(PUB, "d"));
        assert!(!t.admit(PUB, "e"));
        assert_eq!(t.size(), 2);
    }

    #[test]
    fn memory_holds_only_the_addresses_of_the_last_hour_not_every_address_ever_seen() {
        let c = Clock::new();
        let mut t = c.throttle(1);
        for i in 0..1000 {
            assert!(t.admit(&format!("/ip4/203.0.{}.{}/tcp/1/ws", i >> 8, i & 255), &format!("p{i}")));
        }
        assert_eq!(t.tracked(), 1000);
        c.tick(NEW_PEERS_WINDOW_MS);
        assert!(t.admit(PUB, "late"));
        assert_eq!(t.tracked(), 1);
        c.tick(NEW_PEERS_WINDOW_MS);
        assert_eq!(t.size(), 0);
        assert_eq!(t.tracked(), 0);
    }

    #[test]
    fn a_refusal_stores_no_entry_a_limit_of_0_refuses_every_new_identity_and_keeps_nothing() {
        let mut t = IdentityThrottle::new(0).exempt_private(false);
        assert!(!t.admit(PUB, "a"));
        assert!(!t.admit(PUB, "b"));
        assert_eq!(t.refused, 2);
        assert_eq!(t.tracked(), 0);
        assert_eq!(t.size(), 0);
    }

    #[test]
    fn one_ipv6_64_is_one_address() {
        let mut t = IdentityThrottle::new(1).exempt_private(false);
        assert!(t.admit("/ip6/2001:db8:1:2:aaaa::1/tcp/1/ws", "a"));
        assert!(!t.admit("/ip6/2001:db8:1:2:bbbb::2/tcp/1/ws", "b"));
        assert!(t.admit("/ip6/2001:db8:1:3::1/tcp/1/ws", "c"));
    }

    #[test]
    fn loopback_and_private_addresses_are_exempt_by_default_not_when_asked() {
        let mut t = IdentityThrottle::new(1);
        for id in ids(20) {
            assert!(t.admit("/ip4/127.0.0.1/tcp/1/ws", &id));
            assert!(t.admit("/ip4/172.18.0.2/tcp/1/ws", &id));
            assert!(t.admit("/ip4/10.1.2.3/tcp/1/ws", &id));
            assert!(t.admit("/ip6/fd00::1/tcp/1/ws", &id));
        }
        assert_eq!(t.refused, 0);
        assert_eq!(t.size(), 0);
        let mut strict = IdentityThrottle::new(1).exempt_private(false);
        assert!(strict.admit("/ip4/127.0.0.1/tcp/1/ws", "a"));
        assert!(!strict.admit("/ip4/127.0.0.1/tcp/2/ws", "b"));
    }

    #[test]
    fn addresses_live_as_salted_hashes_two_instances_hash_the_same_address_differently() {
        let a = IdentityThrottle::new(5);
        let b = IdentityThrottle::new(5);
        assert_ne!(a.hash("203.0.114.7"), b.hash("203.0.114.7"));
        let fixed = IdentityThrottle::new(5).with_salt([1; 16]);
        assert_eq!(
            fixed.hash("203.0.114.7"),
            IdentityThrottle::new(5).with_salt([1; 16]).hash("203.0.114.7")
        );
        assert!(!fixed.hash("203.0.114.7").contains("203"));
    }
}
