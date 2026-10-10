//! Prints the peer id of a relay key file, so a deployment learns the relay's address
//! without its logs.

use std::path::Path;

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| "relay-key.bin".into());
    match rebellm_relay::keyfile::key_peer_id(Path::new(&path)) {
        Ok(id) => println!("{id}"),
        Err(e) => {
            eprintln!("{path}: {e}");
            std::process::exit(1);
        }
    }
}
