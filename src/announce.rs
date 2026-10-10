//! Gossip verdicts for announces and usage reports: what a browser would not decode is not
//! forwarded (see the web app's `decodeAnnounce` and `decodeReport`).

use serde_json::Value;

use crate::util::{atob, slice_utf16};

pub const ANNOUNCE_TOPIC: &str = "rebellm/announce/1";
pub const REPORT_TOPIC: &str = "rebellm/report/1";
/// Longest usage report a browser sends.
pub const REPORT_MAX_BYTES: usize = 2048;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Accept,
    Reject,
}

/// An announce parsed once, for the validator and the log.
pub struct Announce {
    parsed: Option<Value>,
    pub verdict: Verdict,
}

fn b64_length(v: Option<&Value>) -> Option<usize> {
    atob(v?.as_str()?).map(|b| b.len())
}

/// JavaScript truthiness of a JSON value.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// A JSON number that is a whole number, as `Number.isInteger` has it.
fn integer(v: Option<&Value>) -> Option<f64> {
    v?.as_f64().filter(|f| f.fract() == 0.0)
}

fn verdict_of(o: Option<&Value>) -> Verdict {
    let Some(o) = o.filter(|o| truthy(Some(o))) else {
        return Verdict::Reject;
    };
    if o.get("v").and_then(Value::as_f64) != Some(1.0) || !o.get("model").is_some_and(Value::is_string) {
        return Verdict::Reject;
    }
    let (Some(layers), Some(experts)) = (integer(o.get("layers")), integer(o.get("experts"))) else {
        return Verdict::Reject;
    };
    if layers <= 0.0 || experts <= 0.0 || layers * experts > f64::from(1 << 20) {
        return Verdict::Reject;
    }
    let n = (layers * experts) as usize;
    let bits = n.div_ceil(8);
    if b64_length(o.get("served")) != Some(bits) {
        return Verdict::Reject;
    }
    if truthy(o.get("hot")) && b64_length(o.get("hot")) != Some(bits) {
        return Verdict::Reject;
    }
    if truthy(o.get("demand")) && b64_length(o.get("demand")) != Some(n * 2) {
        return Verdict::Reject;
    }
    Verdict::Accept
}

impl Announce {
    pub fn parse(data: &[u8]) -> Self {
        let parsed = serde_json::from_slice::<Value>(data).ok();
        let verdict = verdict_of(parsed.as_ref());
        Self { parsed, verdict }
    }

    /// `model=<name> experts=<served count>`, plus `gpu="<class>"` when it names one; `None`
    /// when it does not decode.
    pub fn summary(&self) -> Option<String> {
        let o = self.parsed.as_ref()?;
        let model = o.get("model")?.as_str()?;
        let served = atob(o.get("served")?.as_str()?)?;
        let experts: u32 = served.iter().map(|b| b.count_ones()).sum();
        // Quoted: a peer's string must not break or forge a log line.
        let gpu = match o.get("gpu").and_then(Value::as_str) {
            Some(g) => format!(" gpu={}", Value::from(slice_utf16(g, 32))),
            None => String::new(),
        };
        Some(format!("model={model} experts={experts}{gpu}"))
    }
}

/// Gossip verdict for an announce.
pub fn announce_verdict(data: &[u8]) -> Verdict {
    Announce::parse(data).verdict
}

/// Gossip verdict for a usage report: rejected when it does not decode, is over 2 KB, or
/// reaches the relay from another peer than its author, so nobody forwards or forges one.
pub fn report_verdict(data: &[u8], from: Option<&str>, via: Option<&str>) -> Verdict {
    if from.is_none() || from != via || data.len() > REPORT_MAX_BYTES {
        return Verdict::Reject;
    }
    match serde_json::from_slice::<Value>(data) {
        Ok(Value::Object(o)) if o.get("v").and_then(Value::as_f64) == Some(1.0) => Verdict::Accept,
        _ => Verdict::Reject,
    }
}

#[cfg(test)]
mod tests {
    use base64::Engine;
    use serde_json::json;

    use super::*;

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn zeros(n: usize) -> String {
        b64(&vec![0u8; n])
    }

    fn enc(v: Value) -> Vec<u8> {
        serde_json::to_vec(&v).unwrap()
    }

    fn with(base: &Value, key: &str, value: Value) -> Vec<u8> {
        let mut o = base.clone();
        o[key] = value;
        enc(o)
    }

    #[test]
    fn rejects_announces_a_browser_would_not_decode_so_gossip_does_not_forward_them() {
        let good = json!({ "v": 1, "model": "m", "layers": 48, "experts": 128, "served": zeros(768), "addrs": [] });
        assert_eq!(announce_verdict(&enc(good.clone())), Verdict::Accept);
        let mut full = good.clone();
        full["hot"] = json!(zeros(768));
        full["demand"] = json!(zeros(48 * 128 * 2));
        assert_eq!(announce_verdict(&enc(full)), Verdict::Accept);
        let mut huge = good.clone();
        huge["layers"] = json!(2048);
        huge["experts"] = json!(1024);
        huge["served"] = json!(zeros(262_144));
        for bad in [
            b"junk".to_vec(),
            with(&good, "v", json!(2)),
            with(&good, "model", json!(7)),
            with(&good, "layers", json!(0)),
            with(&good, "layers", json!(1.5)),
            enc(huge),
            with(&good, "served", json!(zeros(767))),
            with(&good, "served", json!("*")),
            with(&good, "hot", json!(zeros(10))),
            with(&good, "demand", json!(zeros(10))),
        ] {
            assert_eq!(
                announce_verdict(&bad),
                Verdict::Reject,
                "{}",
                String::from_utf8_lossy(&bad)
            );
        }
        // JSON that is not an object, and an empty optional field, which JavaScript skips.
        assert_eq!(announce_verdict(b"null"), Verdict::Reject);
        assert_eq!(announce_verdict(b"[1]"), Verdict::Reject);
        assert_eq!(announce_verdict(&with(&good, "hot", json!(""))), Verdict::Accept);
    }

    #[test]
    fn an_announce_is_parsed_once_for_the_validator_and_the_log() {
        let data = enc(json!({ "v": 1, "model": "m", "layers": 2, "experts": 4, "served": zeros(1) }));
        // One parse gives the verdict and the summary.
        let a = Announce::parse(&data);
        assert_eq!(a.verdict, Verdict::Accept);
        assert_eq!(a.summary().as_deref(), Some("model=m experts=0"));
        // A rejected announce is remembered as rejected, with nothing to summarise.
        let junk = Announce::parse(b"junk");
        assert_eq!(junk.verdict, Verdict::Reject);
        assert_eq!(junk.summary(), None);
    }

    #[test]
    fn the_summary_names_the_model_the_served_experts_and_the_quoted_gpu() {
        let served = b64(&[0b1011_0000, 0, 0b1, 0]);
        let summary = |v: Value| Announce::parse(&enc(v)).summary();
        assert_eq!(
            summary(json!({ "v": 1, "model": "qwen3-30b", "served": served })).as_deref(),
            Some("model=qwen3-30b experts=4")
        );
        assert_eq!(
            summary(json!({ "v": 1, "model": "m", "served": served, "gpu": "nvidia pascal" })).as_deref(),
            Some("model=m experts=4 gpu=\"nvidia pascal\"")
        );
        assert_eq!(
            summary(json!({ "v": 1, "model": "m", "served": served, "gpu": "x\n2026 open forged" })).as_deref(),
            Some("model=m experts=4 gpu=\"x\\n2026 open forged\"")
        );
        // Without a version it is not valid, but the log still describes it.
        assert_eq!(
            summary(json!({ "model": "m", "served": b64(&[3]) })).as_deref(),
            Some("model=m experts=2")
        );
        assert_eq!(Announce::parse(b"junk").summary(), None);
    }

    const PEER: &str = "12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo";

    fn usage_report() -> Value {
        json!({
            "v": 1,
            "at": 1_790_000_000_000u64,
            "app": "0.0.1+abc",
            "machine": { "gpu": "nvidia pascal", "precision": "f32", "browser": "chrome", "os": "windows" },
            "trunk": { "requests": 3, "tokens": 420 },
            "node": { "calls": 900 },
        })
    }

    #[test]
    fn reports_accepted_when_they_decode_fit_2_kb_and_come_from_their_own_author() {
        let good = enc(usage_report());
        assert_eq!(report_verdict(&good, Some(PEER), Some(PEER)), Verdict::Accept);
        // Unknown fields are fine; a newer browser's extra numbers do not cost it its report.
        let extra = with(&usage_report(), "extra", json!({ "x": 1 }));
        assert_eq!(report_verdict(&extra, Some(PEER), Some(PEER)), Verdict::Accept);
        let oversized = with(&usage_report(), "pad", json!("x".repeat(5 * 1024)));
        assert!(oversized.len() > 5000);
        for (data, from, via) in [
            (oversized, Some(PEER), Some(PEER)),
            (b"junk".to_vec(), Some(PEER), Some(PEER)),
            (with(&usage_report(), "v", json!(2)), Some(PEER), Some(PEER)),
            (enc(json!([1])), Some(PEER), Some(PEER)),
            (enc(json!(null)), Some(PEER), Some(PEER)),
            // Forwarded by another peer, or unsigned: nobody may send a report in another's name.
            (good.clone(), Some(PEER), Some("other")),
            (good.clone(), None, Some(PEER)),
        ] {
            assert_eq!(report_verdict(&data, from, via), Verdict::Reject);
        }
        assert_eq!(REPORT_TOPIC, "rebellm/report/1");
    }
}
