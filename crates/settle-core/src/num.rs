//! Number formatting and points conversion, defined so that Rust and JavaScript agree
//! to the byte.
//!
//! `es_number` is ECMAScript's `Number::toString` (ECMA-262 §6.1.6.1.20), which is also
//! the number format of RFC 8785 (JSON Canonicalization Scheme). Ryū supplies the digits;
//! this module lays them out the ECMAScript way.
//!
//! `points_x100` converts Sleeper's float points to integer hundredths by rounding the
//! *decimal* value (the shortest round-trip string) half away from zero. That makes
//! `162.385` → `16239` everywhere, instead of depending on how `162.385 * 100` happens
//! to land in binary floating point.

/// Shortest round-trip decimal digits and exponent of a finite, non-zero |x|:
/// |x| = 0.d1d2…dk × 10^n. Returns (digits, n).
///
/// Uses Ryū, which picks the shortest digit string that round-trips and, when several
/// exist, the one closest to the exact value (ties to even). That is exactly the `s`
/// ECMA-262 asks for. Rust's own `{:e}` doesn't always pick the closest: for the
/// RFC 8785 vector 0x43143ff3c1cb0959 it prints …206.3 where ECMAScript prints …206.2.
fn shortest_digits(abs: f64) -> (String, i32) {
    debug_assert!(abs.is_finite() && abs > 0.0);
    let mut buf = ryu::Buffer::new();
    let s = buf.format_finite(abs); // e.g. "157.86", "9.0", "1e-7", "1.2345e21"
    let (mant, exp) = match s.split_once(|c| c == 'e' || c == 'E') {
        Some((m, e)) => (m, e.parse::<i32>().expect("ryu exponent")),
        None => (s, 0),
    };
    let (int_part, frac_part) = mant.split_once('.').unwrap_or((mant, ""));
    let mut digits: String = int_part.chars().chain(frac_part.chars()).collect();
    // Digits before the decimal point, counted in `digits`.
    let mut point = int_part.len() as i32 + exp;
    let leading = digits.len() - digits.trim_start_matches('0').len();
    digits.drain(..leading);
    point -= leading as i32;
    let digits = digits.trim_end_matches('0').to_string();
    debug_assert!(!digits.is_empty());
    (digits, point)
}

/// ECMAScript `Number.prototype.toString()` for a finite f64.
///
/// Panics on NaN or infinity, which JSON can't contain.
pub fn es_number(x: f64) -> String {
    assert!(x.is_finite(), "JSON numbers are finite");
    if x == 0.0 {
        return "0".to_string(); // also -0
    }
    let neg = x < 0.0;
    let (digits, n) = shortest_digits(x.abs());
    let k = digits.len() as i32;
    let body = if k <= n && n <= 21 {
        let mut s = digits.clone();
        s.extend(std::iter::repeat('0').take((n - k) as usize));
        s
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{}", "0".repeat((-n) as usize), digits)
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        if k == 1 {
            format!("{}e{}{}", digits, sign, e.abs())
        } else {
            format!("{}.{}e{}{}", &digits[..1], &digits[1..], sign, e.abs())
        }
    };
    if neg {
        format!("-{}", body)
    } else {
        body
    }
}

/// Largest |points| we accept: far beyond any fantasy score, small enough for exact i64 math.
pub const MAX_ABS_POINTS: f64 = 1.0e9;

/// Points → integer hundredths, rounding the decimal value half away from zero.
///
/// Returns `None` for NaN, infinity or |x| > `MAX_ABS_POINTS`.
pub fn points_x100(x: f64) -> Option<i64> {
    if !x.is_finite() || x.abs() > MAX_ABS_POINTS {
        return None;
    }
    if x == 0.0 {
        return Some(0);
    }
    let neg = x < 0.0;
    let (digits, n) = shortest_digits(x.abs());
    let bytes = digits.as_bytes();
    let k = bytes.len() as i32;
    let n2 = n + 2; // number of integer digits after multiplying by 100
    let mut magnitude: i64 = 0;
    for i in 0..n2.max(0) {
        let d = if i < k { (bytes[i as usize] - b'0') as i64 } else { 0 };
        magnitude = magnitude.checked_mul(10)?.checked_add(d)?;
    }
    // First dropped digit decides rounding (half away from zero on the decimal string).
    let first_dropped = if n2 >= 0 && n2 < k { bytes[n2 as usize] - b'0' } else { 0 };
    if first_dropped >= 5 {
        magnitude = magnitude.checked_add(1)?;
    }
    Some(if neg { -magnitude } else { magnitude })
}

/// Formats integer hundredths as a points string with two decimals: 16238 → "162.38".
pub fn format_points_x100(v: i64) -> String {
    let neg = v < 0;
    let a = v.unsigned_abs();
    format!("{}{}.{:02}", if neg { "-" } else { "" }, a / 100, a % 100)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn es_number_matches_ecmascript() {
        // Expected strings are what `String(x)` prints in any ECMAScript engine.
        let cases: &[(f64, &str)] = &[
            (0.0, "0"),
            (-0.0, "0"),
            (9.0, "9"),
            (100.0, "100"),
            (157.86, "157.86"),
            (0.1, "0.1"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (-42.5, "-42.5"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (2f64.powi(53), "9007199254740992"),
            (0.000001234, "0.000001234"),
            (12.0e-1, "1.2"),
        ];
        for (x, want) in cases {
            assert_eq!(es_number(*x), *want, "es_number({x:?})");
        }
    }

    #[test]
    fn points_round_on_the_decimal_value() {
        let cases: &[(f64, i64)] = &[
            (0.0, 0),
            (157.86, 15786),
            (210.54, 21054),
            (9.0, 900),
            (162.385, 16239), // naive (x*100).round() gives 16238
            (162.384, 16238),
            (-1.505, -151), // half away from zero
            (-1.504, -150),
            (0.005, 1),
            (0.0049, 0),
            (1e-7, 0),
            (-0.004, 0),
            (100.0, 10000),
            (0.1 + 0.2, 30),
            (999999999.99, 99999999999),
        ];
        for (x, want) in cases {
            assert_eq!(points_x100(*x), Some(*want), "points_x100({x:?})");
        }
        assert_eq!(points_x100(f64::NAN), None);
        assert_eq!(points_x100(f64::INFINITY), None);
        assert_eq!(points_x100(2e9), None);
    }

    #[test]
    fn negative_zero_rounding_is_zero() {
        assert_eq!(points_x100(-0.0), Some(0));
        assert_eq!(points_x100(-0.001), Some(0));
    }

    #[test]
    fn format_points() {
        assert_eq!(format_points_x100(16238), "162.38");
        assert_eq!(format_points_x100(900), "9.00");
        assert_eq!(format_points_x100(5), "0.05");
        assert_eq!(format_points_x100(-151), "-1.51");
        assert_eq!(format_points_x100(0), "0.00");
    }
}
