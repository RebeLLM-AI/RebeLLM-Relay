//! Who may connect: at most `ACCEPT_PER_SECOND` new connections per second from one host, and
//! the identity throttle, checked at the first point where the peer id and the remote address
//! are both known, before any stream or reservation.

use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use libp2p::core::transport::PortUse;
use libp2p::core::Endpoint;
use libp2p::swarm::{
    dummy, ConnectionDenied, ConnectionId, FromSwarm, NetworkBehaviour, THandler, THandlerInEvent, THandlerOutEvent,
    ToSwarm,
};
use libp2p::{Multiaddr, PeerId};

use crate::gate::{address_key, IdentityThrottle};

/// Connections the relay holds; reservations too, as one without a connection is useless.
pub const MAX_CONNECTIONS: u32 = 1000;
/// New connections per second per source host: behind the proxy the whole site is one host.
pub const ACCEPT_PER_SECOND: u32 = 100;
/// Handshakes in flight, so a wave of redials after a restart queues instead of being refused.
pub const ACCEPT_PENDING: u32 = 256;

/// A connection refused by the identity throttle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused {
    pub peer: String,
    pub addr: String,
}

#[derive(Debug)]
struct Denied(&'static str);

impl std::fmt::Display for Denied {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for Denied {}

pub struct Admission {
    throttle: Option<Arc<Mutex<IdentityThrottle>>>,
    per_second: u32,
    now: Box<dyn Fn() -> u64 + Send>,
    /// Per host: the second being counted and the connections accepted in it.
    accepted: HashMap<String, (u64, u32)>,
    events: VecDeque<Refused>,
    waker: Option<Waker>,
}

impl Admission {
    pub fn new(throttle: Option<Arc<Mutex<IdentityThrottle>>>) -> Self {
        Self {
            throttle,
            per_second: ACCEPT_PER_SECOND,
            now: Box::new(crate::util::now_ms),
            accepted: HashMap::new(),
            events: VecDeque::new(),
            waker: None,
        }
    }

    pub fn with_clock(mut self, now: impl Fn() -> u64 + Send + 'static) -> Self {
        self.now = Box::new(now);
        self
    }

    /// False once a host has opened `per_second` connections within the running second.
    pub fn accept(&mut self, remote_addr: &str) -> bool {
        let host = address_key(remote_addr).unwrap_or_else(|| remote_addr.to_string());
        let second = (self.now)() / 1000;
        // Hosts of earlier seconds carry no state.
        if self.accepted.len() > 10_000 {
            self.accepted.retain(|_, (s, _)| *s == second);
        }
        let slot = self.accepted.entry(host).or_insert((second, 0));
        if slot.0 != second {
            *slot = (second, 0);
        }
        if slot.1 >= self.per_second {
            return false;
        }
        slot.1 += 1;
        true
    }

    /// True to admit the peer; a refusal is queued as an event.
    pub fn admit(&mut self, peer: &str, remote_addr: &str) -> bool {
        let Some(throttle) = &self.throttle else {
            return true;
        };
        if throttle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .admit(remote_addr, peer)
        {
            return true;
        }
        self.events.push_back(Refused {
            peer: peer.to_string(),
            addr: remote_addr.to_string(),
        });
        if let Some(w) = self.waker.take() {
            w.wake()
        }
        false
    }

    pub fn take_refused(&mut self) -> Option<Refused> {
        self.events.pop_front()
    }
}

impl NetworkBehaviour for Admission {
    type ConnectionHandler = dummy::ConnectionHandler;
    type ToSwarm = Refused;

    fn handle_pending_inbound_connection(
        &mut self,
        _: ConnectionId,
        _: &Multiaddr,
        remote_addr: &Multiaddr,
    ) -> Result<(), ConnectionDenied> {
        if self.accept(&remote_addr.to_string()) {
            Ok(())
        } else {
            Err(ConnectionDenied::new(Denied("too many new connections from this host")))
        }
    }

    fn handle_established_inbound_connection(
        &mut self,
        _: ConnectionId,
        peer: PeerId,
        _: &Multiaddr,
        remote_addr: &Multiaddr,
    ) -> Result<THandler<Self>, ConnectionDenied> {
        if self.admit(&peer.to_string(), &remote_addr.to_string()) {
            Ok(dummy::ConnectionHandler)
        } else {
            Err(ConnectionDenied::new(Denied(
                "too many new peer identities from this address",
            )))
        }
    }

    fn handle_established_outbound_connection(
        &mut self,
        _: ConnectionId,
        _: PeerId,
        _: &Multiaddr,
        _: Endpoint,
        _: PortUse,
    ) -> Result<THandler<Self>, ConnectionDenied> {
        Ok(dummy::ConnectionHandler)
    }

    fn on_swarm_event(&mut self, _: FromSwarm) {}

    fn on_connection_handler_event(&mut self, _: PeerId, _: ConnectionId, event: THandlerOutEvent<Self>) {
        let never: Infallible = event;
        match never {}
    }

    fn poll(&mut self, cx: &mut Context<'_>) -> Poll<ToSwarm<Self::ToSwarm, THandlerInEvent<Self>>> {
        match self.take_refused() {
            Some(refused) => Poll::Ready(ToSwarm::GenerateEvent(refused)),
            None => {
                self.waker = Some(cx.waker().clone());
                Poll::Pending
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    const PUB: &str = "/ip4/203.0.114.7/tcp/51000/ws";

    #[test]
    fn the_gate_denies_once_the_peer_and_its_address_are_known_and_reports_each_refusal() {
        let throttle = Arc::new(Mutex::new(IdentityThrottle::new(1).exempt_private(false)));
        let mut gate = Admission::new(Some(throttle.clone()));
        assert!(gate.admit("p1", PUB));
        assert!(!gate.admit("p2", PUB));
        assert!(gate.admit("p1", PUB));
        assert_eq!(
            gate.take_refused(),
            Some(Refused {
                peer: "p2".into(),
                addr: PUB.into()
            })
        );
        assert_eq!(gate.take_refused(), None);
        assert_eq!(throttle.lock().unwrap().refused, 1);
        // Without a throttle everyone is admitted.
        let mut open = Admission::new(None);
        assert!(open.admit("p1", PUB) && open.admit("p2", PUB));
    }

    #[test]
    fn the_relay_takes_a_proxy_100_dials_a_second_from_one_host_256_handshakes_1000_connections() {
        assert_eq!((MAX_CONNECTIONS, ACCEPT_PER_SECOND, ACCEPT_PENDING), (1000, 100, 256));
        let t = Arc::new(AtomicU64::new(5_000));
        let clock = t.clone();
        let mut gate = Admission::new(None).with_clock(move || clock.load(Ordering::SeqCst));
        for port in 0..100 {
            assert!(gate.accept(&format!("/ip4/172.19.0.5/tcp/{port}/ws")), "dial {port}");
        }
        assert!(!gate.accept("/ip4/172.19.0.5/tcp/100/ws"));
        // Another host has its own second; the next second starts over.
        assert!(gate.accept("/ip4/172.19.0.6/tcp/1/ws"));
        t.fetch_add(1000, Ordering::SeqCst);
        assert!(gate.accept("/ip4/172.19.0.5/tcp/101/ws"));
    }
}
