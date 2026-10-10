//! Addresses the fetch proxy must not reach, and the identity throttle exempts.

fn v4(s: &str) -> Option<u32> {
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut n = 0u32;
    for p in parts {
        if p.is_empty() || p.len() > 3 || !p.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let x: u32 = p.parse().ok()?;
        if x > 255 {
            return None;
        }
        n = (n << 8) | x;
    }
    Some(n)
}

/// A dotted quad as `net.isIP` accepts it: no leading zeros.
fn is_ipv4(s: &str) -> bool {
    v4(s).is_some() && s.split('.').all(|p| p.len() == 1 || !p.starts_with('0'))
}

// Loopback, private, shared (CGNAT), link-local, documentation, benchmark, multicast, reserved.
const V4_BLOCKED: [([u8; 4], u32); 14] = [
    ([0, 0, 0, 0], 8),
    ([10, 0, 0, 0], 8),
    ([100, 64, 0, 0], 10),
    ([127, 0, 0, 0], 8),
    ([169, 254, 0, 0], 16),
    ([172, 16, 0, 0], 12),
    ([192, 0, 0, 0], 24),
    ([192, 0, 2, 0], 24),
    ([192, 168, 0, 0], 16),
    ([198, 18, 0, 0], 15),
    ([198, 51, 100, 0], 24),
    ([203, 0, 113, 0], 24),
    ([224, 0, 0, 0], 4),
    ([240, 0, 0, 0], 4),
];

fn blocked_v4(n: u32) -> bool {
    V4_BLOCKED
        .iter()
        .any(|(base, bits)| n >> (32 - bits) == u32::from_be_bytes(*base) >> (32 - bits))
}

/// The eight 16-bit groups of an IPv6 address, or `None`.
fn v6(s: &str) -> Option<[u16; 8]> {
    let mut t = s
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split('%')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    // A dotted quad at the end stands for the last two groups.
    if let Some(i) = t.rfind(':') {
        let tail = &t[i + 1..];
        if tail.contains('.') {
            let n = v4(tail)?;
            t = format!("{}{:x}:{:x}", &t[..=i], n >> 16, n & 0xffff);
        }
    }
    let halves: Vec<&str> = t.split("::").collect();
    if halves.len() > 2 {
        return None;
    }
    let groups_of = |h: &str| -> Vec<String> {
        if h.is_empty() {
            Vec::new()
        } else {
            h.split(':').map(str::to_string).collect()
        }
    };
    let head = groups_of(halves[0]);
    let tail = if halves.len() == 2 {
        groups_of(halves[1])
    } else {
        Vec::new()
    };
    let fill = 8i32 - head.len() as i32 - tail.len() as i32;
    if halves.len() == 1 {
        if fill != 0 {
            return None;
        }
    } else if fill < 1 {
        return None;
    }
    let mut all = head;
    if halves.len() == 2 {
        all.extend(std::iter::repeat_n("0".to_string(), fill as usize));
    }
    all.extend(tail);
    let mut out = [0u16; 8];
    for (i, g) in all.iter().enumerate() {
        if g.is_empty() || g.len() > 4 || !g.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        out[i] = u16::from_str_radix(g, 16).ok()?;
    }
    Some(out)
}

/// True for every address that must not be reached: loopback, private, link-local, multicast,
/// unspecified and reserved ranges, also inside IPv4-mapped, NAT64, 6to4 and Teredo forms.
/// Anything unparsable counts as blocked.
pub fn is_blocked_address(address: &str) -> bool {
    let a = address.strip_prefix('[').unwrap_or(address);
    let a = a.strip_suffix(']').unwrap_or(a);
    if is_ipv4(a) {
        return v4(a).is_none_or(blocked_v4);
    }
    let Some(g) = v6(a) else {
        return true;
    };
    let low = (u32::from(g[6]) << 16) | u32::from(g[7]);
    let zero = |from: usize, to: usize| g[from..to].iter().all(|x| *x == 0);
    // ::, ::1 and the old IPv4-compatible form.
    if zero(0, 6) {
        return blocked_v4(low);
    }
    // IPv4-mapped ::ffff:a.b.c.d and IPv4-translated ::ffff:0:a.b.c.d.
    if zero(0, 5) && g[5] == 0xffff {
        return blocked_v4(low);
    }
    if zero(0, 4) && g[4] == 0xffff && g[5] == 0 {
        return blocked_v4(low);
    }
    // NAT64: the well-known prefix carries an IPv4 address; the local-use one is private.
    if g[0] == 0x64 && g[1] == 0xff9b {
        return !zero(2, 6) || blocked_v4(low);
    }
    // 6to4 embeds the IPv4 address after the prefix.
    if g[0] == 0x2002 {
        return blocked_v4((u32::from(g[1]) << 16) | u32::from(g[2]));
    }
    // Teredo: the server address, and the client address stored inverted.
    if g[0] == 0x2001 && g[1] == 0 {
        return blocked_v4((u32::from(g[2]) << 16) | u32::from(g[3])) || blocked_v4(!low);
    }
    if g[0] == 0x2001 && g[1] == 0xdb8 {
        return true;
    }
    if g[0] == 0x100 && zero(1, 4) {
        return true;
    }
    // Unique local, link-local, site-local, multicast.
    (g[0] & 0xfe00) == 0xfc00 || (g[0] & 0xffc0) == 0xfe80 || (g[0] & 0xffc0) == 0xfec0 || g[0] >= 0xff00
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_loopback_private_link_local_multicast_and_reserved_addresses_in_every_form() {
        for a in [
            "127.0.0.1",
            "127.255.0.9",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "0.0.0.0",
            "100.64.0.1",
            "192.0.2.10",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "[::1]",
            "fe80::1%eth0",
            "fc00::1",
            "fd12:3456::1",
            "fec0::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "::ffff:7f00:1",
            "::ffff:192.168.1.1",
            "::ffff:0:10.0.0.1",
            "64:ff9b::a9fe:a9fe",
            "64:ff9b:1::8.8.8.8",
            "2002:c0a8:101::1",
            "2001:0:4136:e378:0:0:80ff:fffe",
            "2001:db8::1",
            "not an address",
            "1::2::3",
        ] {
            assert!(is_blocked_address(a), "{a}");
        }
        for a in [
            "93.184.215.14",
            "8.8.8.8",
            "172.32.0.1",
            "100.128.0.1",
            "2606:2800:21f:cb07:6820:80da:af6b:8b2c",
            "2002:5db8:d70e::1",
            "::ffff:8.8.8.8",
            "64:ff9b::808:808",
        ] {
            assert!(!is_blocked_address(a), "{a}");
        }
    }
}
