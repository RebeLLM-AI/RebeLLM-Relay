//! The relay's identity: a libp2p private key in its protobuf form, the file the Node.js
//! relay wrote, so the peer id survives the move.

use std::io;
use std::path::Path;

use libp2p::identity::Keypair;

/// Loads the key of `path`, creating an Ed25519 one when the file is missing.
pub fn load_key(path: &Path) -> io::Result<Keypair> {
    match std::fs::read(path) {
        Ok(bytes) => Keypair::from_protobuf_encoding(&bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let key = Keypair::generate_ed25519();
            let bytes = key
                .to_protobuf_encoding()
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            write_private(path, &bytes)?;
            Ok(key)
        }
        Err(e) => Err(e),
    }
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?
        .write_all(bytes)
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    std::fs::write(path, bytes)
}

/// The peer id of an existing key file, without starting a relay.
pub fn key_peer_id(path: &Path) -> io::Result<String> {
    let bytes = std::fs::read(path)?;
    let key = Keypair::from_protobuf_encoding(&bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok(key.public().to_peer_id().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_the_key_once_and_reloads_the_same_identity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("k.bin");
        let a = load_key(&path).unwrap();
        let b = load_key(&path).unwrap();
        assert_eq!(a.public(), b.public());
        assert!(std::fs::read(&path).unwrap().len() > 32);
        assert_eq!(key_peer_id(&path).unwrap(), a.public().to_peer_id().to_string());
    }

    #[test]
    fn reads_a_key_file_the_nodejs_relay_wrote() {
        // privateKeyToProtobuf of a made-up Ed25519 key: type 1, 64 bytes of seed and public key.
        let seed = [7u8; 32];
        let key = libp2p::identity::ed25519::Keypair::from(
            libp2p::identity::ed25519::SecretKey::try_from_bytes(seed).unwrap(),
        );
        let mut file = vec![0x08, 0x01, 0x12, 0x40];
        file.extend_from_slice(&seed);
        file.extend_from_slice(&key.public().to_bytes());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("node.bin");
        std::fs::write(&path, &file).unwrap();
        let id = key_peer_id(&path).unwrap();
        assert!(id.starts_with("12D3KooW"), "{id}");
        assert_eq!(id, Keypair::from(key).public().to_peer_id().to_string());
        assert!(key_peer_id(&dir.path().join("none.bin")).is_err());
    }
}
