//! Prints `<f64 bits hex> <es_number>` for random doubles. Checked against Node by
//! `node fixtures/es-fuzz-check.mjs`. Usage: cargo run -q -p settle-core --example es_fuzz -- 200000
fn main() {
    let n: usize = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(100_000);
    let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut next = || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    let mut out = String::with_capacity(n * 40);
    for i in 0..n {
        let r = next();
        let f = match i % 3 {
            0 => f64::from_bits(r),                              // any bit pattern
            1 => (r % 10_000_000) as f64 / 100.0 - 20_000.0,     // fantasy-like: cents
            _ => (r % 1_000_000_000) as f64 / 1000.0 * if r & 1 == 0 { 1.0 } else { -1e-9 },
        };
        if !f.is_finite() {
            continue;
        }
        out.push_str(&format!("{:016x} {}\n", f.to_bits(), settle_core::num::es_number(f)));
    }
    print!("{out}");
}
