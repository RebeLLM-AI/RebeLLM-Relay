//! Bootstrap and WebRTC signalling for RebeLLM browser peers, plus the assistant's page-fetch
//! proxy; the statistics, the VRAM history and the admin API run in the Node.js sidecar.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::json;
use tokio::sync::{mpsc, oneshot};

use rebellm_relay::fetch::{self, FetchProxy};
use rebellm_relay::keyfile::load_key;
use rebellm_relay::options::{bootstrap_addresses, lan_addresses, parse_options, system_interfaces, Options, USAGE};
use rebellm_relay::process::CountingAlloc;
use rebellm_relay::relay::{Command, Relay, RelayConfig, SIDECAR_QUEUE};
use rebellm_relay::sidecar::{self, SidecarConfig};

#[global_allocator]
static ALLOC: CountingAlloc = CountingAlloc;

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// A test-only knob: a whole number in `REBELLM_TEST_<name>`.
fn knob(name: &str) -> Option<u64> {
    env(&format!("REBELLM_TEST_{name}")).and_then(|v| v.parse().ok())
}

/// `scrypt.<salt>.<hash>`: 16 and 32 bytes, base64url without padding.
fn valid_admin_key(key: &str) -> bool {
    let part =
        |s: &str, len: usize| s.len() == len && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    match key.strip_prefix("scrypt.").and_then(|rest| rest.split_once('.')) {
        Some((salt, hash)) => part(salt, 22) && part(hash, 43),
        None => false,
    }
}

fn die(message: impl std::fmt::Display) -> ! {
    eprintln!("{message}");
    std::process::exit(1)
}

/// The directory the statistics go to: that of the absolute `--stats` path.
fn stats_dir(stats: &str) -> PathBuf {
    let path = std::path::absolute(stats).unwrap_or_else(|_| PathBuf::from(stats));
    path.parent().map_or_else(|| PathBuf::from("."), Path::to_path_buf)
}

async fn stop_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("a SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

fn relay_config(opt: &Options, key: libp2p::identity::Keypair) -> RelayConfig {
    let mut cfg = RelayConfig::new(&opt.host, opt.port, key);
    cfg.announce = opt.announce.clone();
    cfg.new_peers = opt.new_peers;
    cfg.models_secret = opt.models_secret.clone();
    cfg.statistics = opt.stats.is_some();
    cfg.verbose = opt.verbose;
    cfg.lan = lan_addresses(opt.port, &system_interfaces());
    // What the Node.js relay's tests passed as function arguments.
    cfg.exempt_private = env("REBELLM_TEST_THROTTLE_PRIVATE").as_deref() != Some("1");
    if let Some(ms) = knob("PEER_PING_MS") {
        cfg.peer_ping_ms = ms;
    }
    if let Some(ms) = knob("PEER_SILENT_MS") {
        cfg.peer_silent_ms = ms;
    }
    if let Some(n) = knob("STREAMS_PER_LINK") {
        cfg.streams_per_link = n as usize;
    }
    if let Some(ms) = knob("RESERVATION_TTL_MS") {
        cfg.reservation_ttl_ms = ms;
    }
    cfg
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let opt = parse_options(&args, &env).unwrap_or_else(|e| die(e));
    if opt.help {
        println!("{USAGE}");
        return;
    }
    // Checked before the start so a malformed key stops the relay at once.
    if opt.admin_key.as_deref().is_some_and(|k| !valid_admin_key(k)) {
        die("invalid admin key: expected scrypt.<salt>.<hash>");
    }
    let key = load_key(Path::new(&opt.key)).unwrap_or_else(|e| die(format!("{}: {e}", opt.key)));

    // The sidecar keeps the statistics files, and serves the stats port.
    let with_sidecar = opt.stats.is_some() || (opt.admin_key.is_some() && opt.stats_port != 0);
    let (events_tx, events_rx) = mpsc::channel(SIDECAR_QUEUE);
    let (commands_tx, commands_rx) = mpsc::channel(64);

    let relay = Relay::start(relay_config(&opt, key), with_sidecar.then_some(events_tx))
        .await
        .unwrap_or_else(|e| die(format!("relay not started on {}:{}: {e}", opt.host, opt.port)));

    println!("relay {} listening on {}:{}", relay.peer_id, opt.host, opt.port);
    println!("bootstrap addresses (paste one into the RebeLLM settings):");
    for a in bootstrap_addresses(&opt, &relay.peer_id, &lan_addresses(opt.port, &system_interfaces())) {
        println!("  {a}");
    }
    if let Some(stats) = &opt.stats {
        println!(
            "statistics every 5 min to peers-, hot-, reports- and counts-<UTC day>.csv in {}",
            stats_dir(stats).display()
        );
    }
    match relay.new_peers_limit() {
        Some(limit) => println!("new peer identities per address and hour: {limit}"),
        None => println!("new peer identities: unlimited"),
    }
    if relay.model_tokens() {
        println!("model file tokens: on (--models-secret)");
    } else {
        println!("model file tokens: off; the model files must be open");
    }

    let (stop_sidecar, sidecar_stopped) = oneshot::channel();
    let supervisor = with_sidecar.then(|| {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let exe = std::env::current_exe().ok();
        let cfg = SidecarConfig {
            node: env("REBELLM_NODE")
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| "node".into()),
            entry: sidecar::locate(env("REBELLM_SIDECAR"), exe.as_deref(), &cwd),
            options: json!({
                "stats": opt.stats.as_deref().map(|s| std::path::absolute(s).unwrap_or_else(|_| PathBuf::from(s))),
                "statsPort": opt.stats_port,
                "host": opt.host,
                "adminKey": opt.admin_key,
                "intervalMs": knob("STATS_INTERVAL_MS"),
            }),
        };
        tokio::spawn(sidecar::supervise(cfg, events_rx, commands_tx.clone(), sidecar_stopped))
    });

    if opt.fetch_port != 0 {
        // A taken port costs the fetch proxy, not the relay.
        match tokio::net::TcpListener::bind((opt.host.as_str(), opt.fetch_port)).await {
            Ok(listener) => {
                println!("fetch proxy on {}:{}/fetch", opt.host, opt.fetch_port);
                tokio::spawn(fetch::serve(listener, Arc::new(FetchProxy::default())));
            }
            Err(e) => eprintln!("fetch proxy not started: {e}"),
        }
    }

    let running = tokio::spawn(relay.run(commands_rx));
    stop_signal().await;
    let _ = stop_sidecar.send(());
    if let Some(supervisor) = supervisor {
        let _ = supervisor.await;
    }
    let (done, stopped) = oneshot::channel();
    if commands_tx.send(Command::Stop(done)).await.is_ok() {
        let _ = stopped.await;
    }
    let _ = running.await;
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_admin_key_is_scrypt_with_a_16_byte_salt_and_a_32_byte_hash_in_base64url() {
        let key = format!(
            "scrypt.{}.{}",
            "a".repeat(22),
            "B_-9".repeat(11).chars().take(43).collect::<String>()
        );
        assert!(valid_admin_key(&key));
        for bad in [
            "not-a-key",
            "scrypt.a.b",
            "scrypt..",
            &key[1..],
            &format!("{key}x"),
            &key.replace("a", "+"),
        ] {
            assert!(!valid_admin_key(bad), "{bad}");
        }
    }

    #[test]
    fn the_statistics_go_to_the_directory_of_the_stats_path() {
        let dir = stats_dir("some/dir/peers.csv");
        assert!(dir.is_absolute());
        assert!(dir.ends_with("some/dir"));
    }
}
