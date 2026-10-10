//! Model file tokens: the relay signs an expiry with the secret it shares with the file server,
//! whose secure link module checks the same hash. Nothing is stored on either side; one token
//! covers every binary model file until it expires.

use base64::Engine;
use md5::{Digest, Md5};

/// The browser opens this protocol on its relay link and reads one JSON line back.
pub const MODEL_ACCESS_PROTOCOL: &str = "/rebellm/model-access/1.0.0";
/// How long a token lasts; the browser renews with ten minutes left.
pub const MODEL_TOKEN_TTL_S: u64 = 3600;
/// The cookies the browser keeps a token in, as the file server reads them.
pub const COOKIE_EXPIRY: &str = "rebellm_models_e";
pub const COOKIE_SIGNATURE: &str = "rebellm_models_s";

/// base64url MD5 of `<expiry>/models/<secret>`, what nginx's `secure_link_md5` compares against.
pub fn model_signature(secret: &str, e: u64) -> String {
    let digest = Md5::digest(format!("{e}/models/{secret}"));
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

/// A token: the expiry in unix seconds and its signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelToken {
    pub e: u64,
    pub s: String,
}

impl ModelToken {
    /// The line the relay answers with, without its newline.
    pub fn to_json(&self) -> String {
        serde_json::json!({ "v": 1, "e": self.e, "s": self.s }).to_string()
    }
}

pub fn model_token(secret: &str, now_ms: u64, ttl_s: u64) -> ModelToken {
    let e = now_ms / 1000 + ttl_s;
    ModelToken {
        e,
        s: model_signature(secret, e),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenCheck {
    Ok,
    Expired,
    Bad,
}

/// The file server's verdict on a token: ok, expired (nginx answers 410) or bad (403).
pub fn check_model_token(secret: &str, e: Option<&str>, s: Option<&str>, now_ms: u64) -> TokenCheck {
    let (Some(e), Some(s)) = (e, s) else {
        return TokenCheck::Bad;
    };
    if e.is_empty() || e.len() > 12 || !e.bytes().all(|b| b.is_ascii_digit()) {
        return TokenCheck::Bad;
    }
    let Ok(expiry) = e.parse::<u64>() else {
        return TokenCheck::Bad;
    };
    if s != model_signature(secret, expiry) {
        return TokenCheck::Bad;
    }
    if expiry > now_ms / 1000 {
        TokenCheck::Ok
    } else {
        TokenCheck::Expired
    }
}

/// The token's expiry and signature from a Cookie header.
pub fn token_cookies(header: Option<&str>) -> (Option<String>, Option<String>) {
    let (mut e, mut s) = (None, None);
    for part in header.unwrap_or("").split(';') {
        let Some((name, value)) = part.split_once('=') else {
            continue;
        };
        match name.trim() {
            COOKIE_EXPIRY => e = Some(value.trim().to_string()),
            COOKIE_SIGNATURE => s = Some(value.trim().to_string()),
            _ => {}
        }
    }
    (e, s)
}

/// The binaries need the token; manifests, indexes and tokenizer files stay open.
pub fn needs_token(path: &str) -> bool {
    let path = path.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    [".gpx", ".onnx", ".bin"].iter().any(|ext| path.ends_with(ext))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "a3f1c9";
    // 2026-09-28T12:00:00Z
    const NOW: u64 = 1_790_596_800_000;

    #[test]
    fn a_token_is_an_hour_ahead_and_signed_as_nginxs_secure_link_md5_computes_it() {
        let t = model_token(SECRET, NOW, MODEL_TOKEN_TTL_S);
        assert_eq!(t.e, NOW / 1000 + 3600);
        assert_eq!(MODEL_TOKEN_TTL_S, 3600);
        // secure_link_md5 "$secure_link_expires/models/$secret", base64url without padding.
        let md5 = base64::engine::general_purpose::STANDARD.encode(Md5::digest(format!("{}/models/{SECRET}", t.e)));
        assert_eq!(
            t.s,
            md5.replace('+', "-")
                .replace('/', "_")
                .trim_end_matches('=')
                .to_string()
        );
        assert_eq!(t.s, model_signature(SECRET, t.e));
        assert_eq!(t.s.len(), 22);
        assert_eq!(model_token(SECRET, NOW, 60).e, NOW / 1000 + 60);
        assert_eq!(MODEL_ACCESS_PROTOCOL, "/rebellm/model-access/1.0.0");
        let line: serde_json::Value = serde_json::from_str(&t.to_json()).unwrap();
        assert_eq!(line, serde_json::json!({ "v": 1, "e": t.e, "s": t.s }));
    }

    #[test]
    fn the_check_answers_as_the_file_server_does_ok_expired_for_a_signed_past_expiry_bad_otherwise() {
        let t = model_token(SECRET, NOW, MODEL_TOKEN_TTL_S);
        let e = t.e.to_string();
        let s = Some(t.s.as_str());
        assert_eq!(check_model_token(SECRET, Some(&e), s, NOW), TokenCheck::Ok);
        assert_eq!(check_model_token(SECRET, Some(&e), s, NOW + 3_599_000), TokenCheck::Ok);
        assert_eq!(
            check_model_token(SECRET, Some(&e), s, NOW + 3_600_000),
            TokenCheck::Expired
        );
        let other = model_signature("other", t.e);
        assert_eq!(check_model_token(SECRET, Some(&e), Some(&other), NOW), TokenCheck::Bad);
        assert_eq!(
            check_model_token(SECRET, Some(&(t.e + 1).to_string()), s, NOW),
            TokenCheck::Bad
        );
        assert_eq!(check_model_token(SECRET, None, None, NOW), TokenCheck::Bad);
        assert_eq!(check_model_token(SECRET, Some("x"), s, NOW), TokenCheck::Bad);
        assert_eq!(check_model_token(SECRET, Some(&e), Some("42"), NOW), TokenCheck::Bad);
    }

    #[test]
    fn the_cookies_carry_the_expiry_and_the_signature_only_the_binaries_need_them() {
        assert_eq!(
            (COOKIE_EXPIRY, COOKIE_SIGNATURE),
            ("rebellm_models_e", "rebellm_models_s")
        );
        assert_eq!(
            token_cookies(Some("other=1; rebellm_models_e=1790000000; rebellm_models_s=abc_-x")),
            (Some("1790000000".into()), Some("abc_-x".into()))
        );
        assert_eq!(token_cookies(None), (None, None));
        assert_eq!(token_cookies(Some("rebellm_models_e=1")), (Some("1".into()), None));
        for p in [
            "/models/experts-demo/L0E0.gpx",
            "/models/trunk-demo/layer_0.onnx",
            "/models/t/embed.bin?x=1",
            "/a/B.GPX",
        ] {
            assert!(needs_token(p), "{p}");
        }
        for p in [
            "/models/trunk-demo/trunk.json",
            "/models/experts-demo/index.json",
            "/models/t/tokenizer.json",
            "/models/t/merges.txt",
        ] {
            assert!(!needs_token(p), "{p}");
        }
    }
}
