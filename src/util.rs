//! Small helpers that keep the relay's text output and parsing as JavaScript's were.

use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `Date#toISOString` of a time in milliseconds: `2026-09-25T10:00:00.000Z`.
pub fn iso_time(ms: u64) -> String {
    let secs = ms / 1000;
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // Civil date from days since the epoch (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        ms % 1000
    )
}

/// `Number(text)` for the strings options carry: decimal, exponent, hex, octal and binary
/// forms, surrounding whitespace ignored, an empty string 0, anything else NaN.
pub fn js_number(text: &str) -> f64 {
    let t = text.trim();
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = t.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix).map_or(f64::NAN, |n| n as f64);
        }
    }
    match t {
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        // Rust also reads "inf" and "nan", which JavaScript does not.
        _ if t.chars().any(|c| c.is_ascii_alphabetic() && c != 'e' && c != 'E') => f64::NAN,
        _ => t.parse().unwrap_or(f64::NAN),
    }
}

/// A number as JavaScript prints it in a template string: no trailing `.0`.
pub fn js_format(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// `atob`: forgiving base64, or `None` where `atob` throws.
pub fn atob(text: &str) -> Option<Vec<u8>> {
    let mut chars: Vec<u8> = text
        .bytes()
        .filter(|b| !matches!(b, b'\t' | b'\n' | 0x0c | b'\r' | b' '))
        .collect();
    if chars.len() % 4 == 0 {
        for _ in 0..2 {
            if chars.last() == Some(&b'=') {
                chars.pop();
            }
        }
    }
    if chars.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(chars.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in chars {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// The first `units` UTF-16 code units of a string, as `String#slice(0, units)` gives them;
/// a character that would be cut in half is left out.
pub fn slice_utf16(text: &str, units: usize) -> &str {
    let mut used = 0;
    for (i, c) in text.char_indices() {
        used += c.len_utf16();
        if used > units {
            return &text[..i];
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_time_is_javascripts() {
        assert_eq!(iso_time(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_time(1_790_330_400_000), "2026-09-25T10:00:00.000Z");
        assert_eq!(iso_time(1_790_639_999_999), "2026-09-28T23:59:59.999Z");
        assert_eq!(iso_time(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn numbers_parse_as_javascripts() {
        assert_eq!(js_number("9090"), 9090.0);
        assert_eq!(js_number(""), 0.0);
        assert_eq!(js_number(" 5 "), 5.0);
        assert_eq!(js_number("0x10"), 16.0);
        assert_eq!(js_number("1e3"), 1000.0);
        assert_eq!(js_number("-1"), -1.0);
        assert!(js_number("x").is_nan());
        assert!(js_number("many").is_nan());
        assert!(js_number("nan").is_nan());
        assert!(js_number("inf").is_nan());
        assert!(js_number("1_000").is_nan());
        assert_eq!(js_format(15.0), "15");
        assert_eq!(js_format(0.05), "0.05");
        assert_eq!(js_format(2.0), "2");
    }

    #[test]
    fn atob_is_forgiving_like_the_browsers() {
        assert_eq!(atob("AAEC"), Some(vec![0, 1, 2]));
        assert_eq!(atob("AAE="), Some(vec![0, 1]));
        assert_eq!(atob("AAE"), Some(vec![0, 1]));
        assert_eq!(atob("AA E\n="), Some(vec![0, 1]));
        assert_eq!(atob(""), Some(vec![]));
        assert_eq!(atob("*"), None);
        assert_eq!(atob("A"), None);
        assert_eq!(atob("AA=A"), None);
    }

    #[test]
    fn slices_by_utf16_units() {
        assert_eq!(slice_utf16("abcdef", 3), "abc");
        assert_eq!(slice_utf16("ab", 3), "ab");
        assert_eq!(slice_utf16("a\u{1F600}b", 2), "a");
        assert_eq!(slice_utf16("a\u{1F600}b", 3), "a\u{1F600}");
    }
}
