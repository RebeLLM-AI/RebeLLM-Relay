//! The command line of the relay: the flags, environment variables and messages of the
//! Node.js relay it replaces.

use crate::gate::NEW_PEERS_DEFAULT;
use crate::util::js_number;

pub const USAGE: &str = "rebellm-relay [--port 9090] [--host 0.0.0.0] [--key relay-key.bin] [--announce <multiaddr>]...
               [--fetch-port 9091] [--verbose] [--stats <file>] [--stats-port 9092] [--new-peers 5]
               [--models-secret <secret>] [--admin-key <key>]
  --key         file holding the relay identity, created on first run so the address stays stable
  --announce    public multiaddr to advertise, e.g. /dns4/relay.example.org/tcp/443/wss
  --fetch-port  port of the assistant's page-fetch proxy (GET /fetch?url=); off by default
                (REBELLM_FETCH_PORT), for a private network's own relay
  --verbose     one console line per connection, announce, reservation and relayed stream
                (also REBELLM_RELAY_VERBOSE=1); by default only peer counts on change
  --stats       base path of the statistics (also REBELLM_RELAY_STATS): every 5 minutes total
                and network rows go to peers-<UTC day>.csv beside it, the hottest experts to
                hot-<day>.csv, the usage reports to reports-<day>.csv and the node and reporter
                counts to counts-<day>.csv, with no peer id in any; days older than 12 months
                are deleted once a day, and history.json beside it keeps the network's totals
                for the chart
  --stats-port  port of the network's VRAM history from those statistics (GET /stats/history,
                ?days=N for the last N days) and of the admin API; 9092 with --stats or
                --admin-key, 0 turns it off (REBELLM_STATS_PORT)
  --new-peers   new peer identities one address may bring per hour, counted in memory under a
                salted hash; loopback and private addresses are exempt; 0 turns it off
                (REBELLM_NEW_PEERS)
  --models-secret
                the secret the file server checks model file tokens with: connected peers get
                a token an hour long on /rebellm/model-access/1.0.0 (REBELLM_MODELS_SECRET);
                without it no token is offered and the files must be open
  --admin-key   scrypt key of the admin login (deploy.mjs derives it from REBELLM_ADMIN_AUTH):
                GET /admin/api/live and /admin/api/history on the stats port answer only that
                login (REBELLM_ADMIN_KEY); without it they answer 404";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    pub port: u16,
    pub host: String,
    pub key: String,
    pub announce: Vec<String>,
    pub fetch_port: u16,
    pub verbose: bool,
    pub stats: Option<String>,
    pub stats_port: u16,
    pub help: bool,
    pub new_peers: u64,
    pub models_secret: Option<String>,
    pub admin_key: Option<String>,
}

const STRINGS: [&str; 9] = [
    "port",
    "host",
    "key",
    "announce",
    "fetch-port",
    "stats",
    "stats-port",
    "new-peers",
    "models-secret",
];
const BOOLEANS: [&str; 2] = ["verbose", "help"];

fn port_of(v: &str, name: &str, min: f64) -> Result<u16, String> {
    let port = js_number(v);
    if port.fract() != 0.0 || !port.is_finite() || port < min || port > 65535.0 {
        return Err(format!("invalid {name} {v}"));
    }
    Ok(port as u16)
}

fn count_of(v: &str, name: &str) -> Result<u64, String> {
    let n = js_number(v);
    if n.fract() != 0.0 || !n.is_finite() || n < 0.0 {
        return Err(format!("invalid {name} {v}"));
    }
    Ok(n as u64)
}

/// A value that counts when it is set and not empty, as `value || undefined` did.
fn filled(v: Option<String>) -> Option<String> {
    v.filter(|s| !s.is_empty())
}

/// Parses the arguments after the program name; `env` reads an environment variable.
pub fn parse_options(args: &[String], env: &dyn Fn(&str) -> Option<String>) -> Result<Options, String> {
    let mut strings: Vec<(String, String)> = Vec::new();
    let mut verbose = false;
    let mut help = false;
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        i += 1;
        let Some(body) = arg.strip_prefix("--") else {
            return Err(format!(
                "Unexpected argument '{arg}'. This command does not take positional arguments"
            ));
        };
        let (name, inline) = match body.split_once('=') {
            Some((n, v)) => (n, Some(v.to_string())),
            None => (body, None),
        };
        if BOOLEANS.contains(&name) {
            if inline.is_some() {
                return Err(format!("Option '--{name}' does not take an argument"));
            }
            match name {
                "verbose" => verbose = true,
                _ => help = true,
            }
        } else if STRINGS.contains(&name) || name == "admin-key" {
            let value = match inline {
                Some(v) => v,
                None => {
                    let next = args.get(i).filter(|v| !v.starts_with('-'));
                    i += 1;
                    next.cloned()
                        .ok_or_else(|| format!("Option '--{name} <value>' argument missing"))?
                }
            };
            strings.push((name.to_string(), value));
        } else {
            return Err(format!("Unknown option '--{name}'"));
        }
    }
    // The last of a repeated option wins, except --announce, which collects.
    let last = |name: &str| strings.iter().rev().find(|(n, _)| n == name).map(|(_, v)| v.clone());
    let announce = strings
        .iter()
        .filter(|(n, _)| n == "announce")
        .map(|(_, v)| v.clone())
        .collect();
    let stats = filled(last("stats")).or_else(|| filled(env("REBELLM_RELAY_STATS")));
    let admin_key = filled(last("admin-key")).or_else(|| filled(env("REBELLM_ADMIN_KEY")));
    let port = port_of(&last("port").unwrap_or_else(|| "9090".into()), "port", 1.0)?;
    // Off unless asked for: a public relay must not fetch pages for anyone who can reach it.
    let fetch_port = port_of(
        &last("fetch-port")
            .or_else(|| env("REBELLM_FETCH_PORT"))
            .unwrap_or_else(|| "0".into()),
        "fetch port",
        0.0,
    )?;
    // Without statistics or an admin key there is nothing to serve.
    let default_stats_port = if stats.is_some() || admin_key.is_some() {
        "9092"
    } else {
        "0"
    };
    let stats_port = port_of(
        &last("stats-port")
            .or_else(|| env("REBELLM_STATS_PORT"))
            .unwrap_or_else(|| default_stats_port.into()),
        "stats port",
        0.0,
    )?;
    let new_peers = count_of(
        &last("new-peers")
            .or_else(|| env("REBELLM_NEW_PEERS"))
            .unwrap_or_else(|| NEW_PEERS_DEFAULT.to_string()),
        "new-peers",
    )?;
    Ok(Options {
        port,
        host: last("host").unwrap_or_else(|| "0.0.0.0".into()),
        key: last("key").unwrap_or_else(|| "relay-key.bin".into()),
        announce,
        fetch_port,
        verbose: verbose || env("REBELLM_RELAY_VERBOSE").as_deref() == Some("1"),
        stats,
        stats_port,
        help,
        new_peers,
        models_secret: filled(last("models-secret")).or_else(|| filled(env("REBELLM_MODELS_SECRET"))),
        admin_key,
    })
}

/// The addresses to print for peers: the announced ones, else loopback plus `lan`.
pub fn bootstrap_addresses(opt: &Options, peer_id: &str, lan: &[String]) -> Vec<String> {
    let base: Vec<String> = if opt.announce.is_empty() {
        std::iter::once(format!("/ip4/127.0.0.1/tcp/{}/ws", opt.port))
            .chain(lan.iter().cloned())
            .collect()
    } else {
        opt.announce.clone()
    };
    base.into_iter().map(|a| format!("{a}/p2p/{peer_id}")).collect()
}

/// One network interface address, as far as the bootstrap list cares.
pub struct Interface {
    pub ipv4: Option<std::net::Ipv4Addr>,
    pub internal: bool,
}

/// `/ip4/<address>/tcp/<port>/ws` for every external IPv4 interface address.
pub fn lan_addresses(port: u16, interfaces: &[Interface]) -> Vec<String> {
    interfaces
        .iter()
        .filter(|i| !i.internal)
        .filter_map(|i| i.ipv4)
        .map(|a| format!("/ip4/{a}/tcp/{port}/ws"))
        .collect()
}

/// The machine's interfaces; none when they cannot be read.
pub fn system_interfaces() -> Vec<Interface> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .map(|i| Interface {
            ipv4: match i.ip() {
                std::net::IpAddr::V4(a) => Some(a),
                std::net::IpAddr::V6(_) => None,
            },
            internal: i.is_loopback(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn parse(list: &[&str], env: &[(&str, &str)]) -> Result<Options, String> {
        let env: Vec<(String, String)> = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        parse_options(&args(list), &|name| {
            env.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
        })
    }

    fn ok(list: &[&str], env: &[(&str, &str)]) -> Options {
        parse(list, env).unwrap()
    }

    fn err(list: &[&str], env: &[(&str, &str)]) -> String {
        parse(list, env).unwrap_err()
    }

    #[test]
    fn parses_defaults_and_repeated_announce_addresses() {
        assert_eq!(
            ok(&[], &[]),
            Options {
                port: 9090,
                host: "0.0.0.0".into(),
                key: "relay-key.bin".into(),
                announce: vec![],
                fetch_port: 0,
                verbose: false,
                stats: None,
                stats_port: 0,
                help: false,
                new_peers: 5,
                models_secret: None,
                admin_key: None,
            }
        );
        let o = ok(
            &[
                "--port",
                "443",
                "--announce",
                "/dns4/a/tcp/443/wss",
                "--announce",
                "/ip4/1.2.3.4/tcp/443/ws",
            ],
            &[],
        );
        assert_eq!(o.port, 443);
        assert_eq!(o.announce.len(), 2);
        assert!(err(&["--port", "70000"], &[]).contains("invalid port"));
        assert!(err(&["--port", "0"], &[]).contains("invalid port"));
    }

    #[test]
    fn the_identity_throttle_defaults_to_5_new_peers_per_address_and_hour_0_turns_it_off_junk_fails() {
        assert_eq!(ok(&["--new-peers", "0"], &[]).new_peers, 0);
        assert_eq!(ok(&["--new-peers", "20"], &[]).new_peers, 20);
        assert_eq!(ok(&[], &[("REBELLM_NEW_PEERS", "3")]).new_peers, 3);
        assert!(err(&["--new-peers=-1"], &[]).contains("invalid new-peers"));
        assert!(err(&["--new-peers", "many"], &[]).contains("invalid new-peers"));
        assert!(USAGE.contains("--new-peers"));
    }

    #[test]
    fn the_models_secret_comes_from_the_flag_or_the_environment_else_no_tokens() {
        assert_eq!(
            ok(&["--models-secret", "abc"], &[]).models_secret.as_deref(),
            Some("abc")
        );
        assert_eq!(
            ok(&[], &[("REBELLM_MODELS_SECRET", "env")]).models_secret.as_deref(),
            Some("env")
        );
        assert_eq!(
            ok(&["--models-secret", "abc"], &[("REBELLM_MODELS_SECRET", "env")])
                .models_secret
                .as_deref(),
            Some("abc")
        );
        assert_eq!(ok(&[], &[("REBELLM_MODELS_SECRET", "")]).models_secret, None);
        assert!(USAGE.contains("--models-secret"));
    }

    #[test]
    fn the_fetch_port_can_be_moved_or_turned_off_verbose_comes_from_the_flag_or_the_environment() {
        assert_eq!(ok(&["--fetch-port", "0"], &[]).fetch_port, 0);
        assert_eq!(ok(&["--fetch-port", "8081"], &[]).fetch_port, 8081);
        // Off by default; the environment turns it on for a private relay, the flag wins.
        assert_eq!(ok(&[], &[("REBELLM_FETCH_PORT", "9091")]).fetch_port, 9091);
        assert_eq!(
            ok(&["--fetch-port", "0"], &[("REBELLM_FETCH_PORT", "9091")]).fetch_port,
            0
        );
        assert!(err(&["--fetch-port", "x"], &[]).contains("invalid fetch port"));
        assert!(ok(&["--verbose"], &[]).verbose);
        assert!(ok(&[], &[("REBELLM_RELAY_VERBOSE", "1")]).verbose);
        assert!(!ok(&[], &[("REBELLM_RELAY_VERBOSE", "")]).verbose);
    }

    #[test]
    fn the_stats_file_comes_from_the_flag_else_the_environment_none_by_default() {
        assert_eq!(
            ok(&["--stats", "/data/peers.csv"], &[]).stats.as_deref(),
            Some("/data/peers.csv")
        );
        assert_eq!(
            ok(&[], &[("REBELLM_RELAY_STATS", "/data/p.csv")]).stats.as_deref(),
            Some("/data/p.csv")
        );
        assert_eq!(
            ok(&["--stats", "a.csv"], &[("REBELLM_RELAY_STATS", "b.csv")])
                .stats
                .as_deref(),
            Some("a.csv")
        );
        assert_eq!(ok(&[], &[("REBELLM_RELAY_STATS", "")]).stats, None);
        assert_eq!(ok(&[], &[]).stats, None);
    }

    #[test]
    fn the_vram_history_listens_on_9092_with_statistics_elsewhere_or_nowhere_when_asked_never_without_them() {
        assert_eq!(ok(&["--stats", "p.csv"], &[]).stats_port, 9092);
        assert_eq!(ok(&[], &[("REBELLM_RELAY_STATS", "/data/p.csv")]).stats_port, 9092);
        assert_eq!(ok(&["--stats", "p.csv", "--stats-port", "8092"], &[]).stats_port, 8092);
        assert_eq!(
            ok(&["--stats", "p.csv"], &[("REBELLM_STATS_PORT", "7092")]).stats_port,
            7092
        );
        assert_eq!(
            ok(
                &["--stats", "p.csv", "--stats-port", "0"],
                &[("REBELLM_STATS_PORT", "7092")]
            )
            .stats_port,
            0
        );
        assert_eq!(ok(&[], &[]).stats_port, 0);
        assert!(err(&["--stats-port", "x"], &[]).contains("invalid stats port"));
    }

    #[test]
    fn the_admin_key_comes_from_the_flag_or_the_environment_and_opens_the_stats_port() {
        assert_eq!(
            ok(&["--admin-key", "scrypt.a.b"], &[]).admin_key.as_deref(),
            Some("scrypt.a.b")
        );
        assert_eq!(
            ok(&[], &[("REBELLM_ADMIN_KEY", "scrypt.c.d")]).admin_key.as_deref(),
            Some("scrypt.c.d")
        );
        assert_eq!(
            ok(&["--admin-key", "scrypt.a.b"], &[("REBELLM_ADMIN_KEY", "scrypt.c.d")])
                .admin_key
                .as_deref(),
            Some("scrypt.a.b")
        );
        // The deploy writes an empty line when there is no admin login.
        assert_eq!(ok(&[], &[("REBELLM_ADMIN_KEY", "")]).admin_key, None);
        assert_eq!(ok(&[], &[("REBELLM_ADMIN_KEY", "scrypt.c.d")]).stats_port, 9092);
        assert_eq!(
            ok(&[], &[("REBELLM_ADMIN_KEY", "k"), ("REBELLM_STATS_PORT", "0")]).stats_port,
            0
        );
        assert!(USAGE.contains("--admin-key"));
    }

    #[test]
    fn unknown_options_missing_values_and_positionals_fail() {
        assert!(err(&["--nope"], &[]).contains("Unknown option"));
        assert!(err(&["--port"], &[]).contains("argument missing"));
        assert!(err(&["9090"], &[]).contains("positional"));
        assert!(err(&["--verbose=1"], &[]).contains("does not take an argument"));
        assert!(ok(&["--help"], &[]).help);
    }

    #[test]
    fn lists_only_external_ipv4_interfaces() {
        let ifs = [
            Interface {
                ipv4: Some("127.0.0.1".parse().unwrap()),
                internal: true,
            },
            Interface {
                ipv4: Some("192.168.1.5".parse().unwrap()),
                internal: false,
            },
            Interface {
                ipv4: None,
                internal: false,
            },
        ];
        assert_eq!(lan_addresses(9090, &ifs), vec!["/ip4/192.168.1.5/tcp/9090/ws"]);
    }

    #[test]
    fn prints_announced_addresses_instead_of_local_ones() {
        let opt = ok(&["--announce", "/dns4/r.example/tcp/443/wss"], &[]);
        assert_eq!(
            bootstrap_addresses(&opt, "PEER", &[]),
            vec!["/dns4/r.example/tcp/443/wss/p2p/PEER"]
        );
        assert_eq!(
            bootstrap_addresses(&ok(&[], &[]), "PEER", &[]),
            vec!["/ip4/127.0.0.1/tcp/9090/ws/p2p/PEER"]
        );
    }
}
