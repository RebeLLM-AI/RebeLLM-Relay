//! Starts the Node.js sidecar that keeps the statistics, feeds it the relay's events and
//! answers its questions, in JSON lines over its standard streams. The relay never waits
//! for it: a sidecar that is missing or dies costs the statistics, not the relay.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command as Process};
use tokio::sync::{mpsc, oneshot};

use crate::relay::Command;

/// Version of the line protocol, sent in `hello`.
pub const PROTOCOL: u32 = 1;
const FIRST_DELAY: Duration = Duration::from_secs(1);
const MAX_DELAY: Duration = Duration::from_secs(60);
/// A sidecar that ran this long was healthy: its next restart starts from the first delay.
const HEALTHY: Duration = Duration::from_secs(60);
const ANSWER_WITHIN: Duration = Duration::from_secs(5);

pub struct SidecarConfig {
    /// The Node.js binary.
    pub node: String,
    /// The sidecar's entry file.
    pub entry: PathBuf,
    /// The relay's options the sidecar needs: `stats`, `statsPort`, `host`, `adminKey`, `intervalMs`.
    pub options: Value,
}

/// The sidecar's entry file: `REBELLM_SIDECAR`, else `sidecar/index.ts` beside the binary, up
/// to two directories above it (a Cargo build directory) or in the working directory.
pub fn locate(env: Option<String>, exe: Option<&Path>, cwd: &Path) -> PathBuf {
    if let Some(path) = env.filter(|p| !p.is_empty()) {
        return PathBuf::from(path);
    }
    let entry = Path::new("sidecar").join("index.ts");
    let mut bases: Vec<PathBuf> = Vec::new();
    let mut dir = exe.and_then(Path::parent);
    for _ in 0..3 {
        let Some(d) = dir else { break };
        bases.push(d.to_path_buf());
        dir = d.parent();
    }
    bases.push(cwd.to_path_buf());
    bases
        .iter()
        .map(|b| b.join(&entry))
        .find(|p| p.is_file())
        .unwrap_or_else(|| cwd.join(entry))
}

/// The delay before the next start: doubled up to a minute, the first one after a healthy run.
pub fn next_delay(previous: Duration, ran: Duration) -> Duration {
    if ran >= HEALTHY {
        FIRST_DELAY
    } else {
        (previous * 2).min(MAX_DELAY)
    }
}

async fn write_line(stdin: &mut ChildStdin, value: &Value) -> std::io::Result<()> {
    let mut line = value.to_string();
    line.push('\n');
    stdin.write_all(line.as_bytes()).await
}

/// The relay's answer to a command, or `None` when it is gone or slow.
async fn ask(commands: &mpsc::Sender<Command>, make: impl FnOnce(oneshot::Sender<Value>) -> Command) -> Option<Value> {
    let (reply, answer) = oneshot::channel();
    commands.send(make(reply)).await.ok()?;
    tokio::time::timeout(ANSWER_WITHIN, answer).await.ok()?.ok()
}

enum Ended {
    /// The relay is stopping.
    Stop,
    /// The sidecar's output closed, or its input broke.
    Exited,
}

async fn serve(
    child: &mut Child,
    cfg: &SidecarConfig,
    events: &mut mpsc::Receiver<Value>,
    commands: &mpsc::Sender<Command>,
    stop: &mut oneshot::Receiver<()>,
) -> Ended {
    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        return Ended::Exited;
    };
    let Some(mut hello) = ask(commands, Command::Hello).await else {
        return Ended::Stop;
    };
    hello["t"] = json!("hello");
    hello["v"] = json!(PROTOCOL);
    hello["options"] = cfg.options.clone();
    if write_line(&mut stdin, &hello).await.is_err() {
        return Ended::Exited;
    }
    let mut lines = BufReader::new(stdout).lines();
    loop {
        tokio::select! {
            _ = &mut *stop => {
                // Closing its input tells the sidecar to finish its writes and exit.
                drop(stdin);
                return Ended::Stop;
            }
            event = events.recv() => {
                let Some(event) = event else { return Ended::Stop };
                if write_line(&mut stdin, &event).await.is_err() {
                    return Ended::Exited;
                }
            }
            line = lines.next_line() => {
                let Ok(Some(line)) = line else { return Ended::Exited };
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    // Not the protocol: something printed to stdout by mistake.
                    println!("{line}");
                    continue;
                };
                match message["t"].as_str() {
                    Some("log") => println!("{}", message["line"].as_str().unwrap_or("")),
                    Some("err") => eprintln!("{}", message["line"].as_str().unwrap_or("")),
                    Some("reset") => {
                        let _ = commands.send(Command::ResetLag).await;
                    }
                    Some("get") => {
                        let snapshot = ask(commands, Command::Snapshot).await.unwrap_or(Value::Null);
                        let answer = json!({ "t": "res", "id": message["id"], "snapshot": snapshot });
                        if write_line(&mut stdin, &answer).await.is_err() {
                            return Ended::Exited;
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

/// Runs the sidecar until `stop` fires, starting it again whenever it ends.
pub async fn supervise(
    cfg: SidecarConfig,
    mut events: mpsc::Receiver<Value>,
    commands: mpsc::Sender<Command>,
    mut stop: oneshot::Receiver<()>,
) {
    let mut delay = FIRST_DELAY;
    loop {
        let started = Instant::now();
        let spawned = Process::new(&cfg.node)
            .arg(&cfg.entry)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn();
        let reason = match spawned {
            Ok(mut child) => match serve(&mut child, &cfg, &mut events, &commands, &mut stop).await {
                Ended::Stop => {
                    if tokio::time::timeout(Duration::from_secs(3), child.wait())
                        .await
                        .is_err()
                    {
                        let _ = child.kill().await;
                    }
                    return;
                }
                Ended::Exited => {
                    let _ = child.start_kill();
                    match child.wait().await {
                        Ok(status) => format!("exited ({status})"),
                        Err(e) => format!("exited ({e})"),
                    }
                }
            },
            Err(e) => format!("not started ({} {}: {e})", cfg.node, cfg.entry.display()),
        };
        eprintln!(
            "{} statistics sidecar {reason}; the relay goes on without statistics and tries again in {} s",
            crate::util::iso_time(crate::util::now_ms()),
            delay.as_secs()
        );
        let wait = tokio::time::sleep(delay);
        tokio::pin!(wait);
        loop {
            tokio::select! {
                _ = &mut wait => break,
                _ = &mut stop => return,
                // Nobody reads them: an event of the gap is dropped, not delivered late.
                event = events.recv() => if event.is_none() { return },
            }
        }
        delay = next_delay(delay, started.elapsed());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sidecar_is_found_by_the_environment_beside_the_binary_or_in_the_working_directory() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let cwd = root.join("elsewhere");
        std::fs::create_dir_all(&cwd).unwrap();
        // Nothing anywhere: the working directory's path, which then fails to start.
        assert_eq!(locate(None, None, &cwd), cwd.join("sidecar").join("index.ts"));
        assert_eq!(
            locate(Some("/opt/s/index.ts".into()), None, &cwd),
            PathBuf::from("/opt/s/index.ts")
        );
        assert_eq!(
            locate(Some(String::new()), None, &cwd),
            cwd.join("sidecar").join("index.ts")
        );
        // A build directory two levels below the checkout.
        let exe = root.join("target").join("debug").join("rebellm-relay");
        std::fs::create_dir_all(root.join("sidecar")).unwrap();
        std::fs::write(root.join("sidecar").join("index.ts"), "").unwrap();
        assert_eq!(locate(None, Some(&exe), &cwd), root.join("sidecar").join("index.ts"));
        // Beside the binary wins.
        let beside = root.join("target").join("debug").join("sidecar");
        std::fs::create_dir_all(&beside).unwrap();
        std::fs::write(beside.join("index.ts"), "").unwrap();
        assert_eq!(locate(None, Some(&exe), &cwd), beside.join("index.ts"));
    }

    #[test]
    fn restarts_wait_longer_each_time_up_to_a_minute_and_start_over_after_a_healthy_run() {
        let short = Duration::from_secs(2);
        let mut delay = FIRST_DELAY;
        let mut seen = Vec::new();
        for _ in 0..8 {
            seen.push(delay.as_secs());
            delay = next_delay(delay, short);
        }
        assert_eq!(seen, [1, 2, 4, 8, 16, 32, 60, 60]);
        assert_eq!(next_delay(delay, Duration::from_secs(61)), FIRST_DELAY);
    }

    #[tokio::test]
    async fn a_sidecar_that_cannot_be_started_leaves_the_relay_running_and_stops_when_asked() {
        let (events_tx, events_rx) = mpsc::channel(4);
        let (commands_tx, mut commands_rx) = mpsc::channel(4);
        let (stop_tx, stop_rx) = oneshot::channel();
        let cfg = SidecarConfig {
            node: "rebellm-no-such-node-binary".into(),
            entry: PathBuf::from("sidecar/index.ts"),
            options: json!({}),
        };
        let supervisor = tokio::spawn(supervise(cfg, events_rx, commands_tx, stop_rx));
        // Events sent meanwhile are taken and dropped: the sender never blocks for long.
        for i in 0..20 {
            tokio::time::timeout(Duration::from_secs(2), events_tx.send(json!({ "t": "open", "n": i })))
                .await
                .expect("the queue is drained while the sidecar is down")
                .unwrap();
        }
        // No command reaches the relay from a sidecar that never ran.
        assert!(commands_rx.try_recv().is_err());
        stop_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), supervisor)
            .await
            .unwrap()
            .unwrap();
    }
}
