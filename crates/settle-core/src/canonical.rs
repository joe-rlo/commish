//! RFC 8785 JSON Canonicalization Scheme (JCS) and SHA-256.
//!
//! - object keys sorted by UTF-16 code units
//! - no whitespace
//! - strings: only `"`, `\` and control characters are escaped (as `JSON.stringify` does)
//! - numbers: IEEE-754 doubles printed with ECMAScript `Number::toString`
//!
//! In JavaScript the same bytes come from `JSON.stringify` with sorted keys, because
//! `JSON.stringify` already uses that number format. `web/src/settle/canonical.ts`
//! implements it and is tested against the same fixtures.

use crate::num::es_number;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Canonical JSON of a value.
pub fn canonicalize(v: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, v);
    out
}

fn write_value(out: &mut String, v: &Value) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&number_string(n)),
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(out, k);
                out.push(':');
                write_value(out, &map[*k]);
            }
            out.push('}');
        }
    }
}

/// JSON numbers are doubles in JCS. Integers that fit exactly print as integers, which is
/// what ECMAScript prints for them too.
fn number_string(n: &serde_json::Number) -> String {
    const EXACT: u64 = 1 << 53;
    if let Some(u) = n.as_u64() {
        if u <= EXACT {
            return u.to_string();
        }
        return es_number(u as f64);
    }
    if let Some(i) = n.as_i64() {
        if i.unsigned_abs() <= EXACT {
            return i.to_string();
        }
        return es_number(i as f64);
    }
    es_number(n.as_f64().expect("a JSON number is finite"))
}

fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Lowercase hex SHA-256.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// SHA-256 of the canonical JSON of a value.
pub fn canonical_sha256(v: &Value) -> String {
    sha256_hex(canonicalize(v).as_bytes())
}

/// Serializes any value as canonical JSON.
pub fn to_canonical_string<T: serde::Serialize>(v: &T) -> String {
    canonicalize(&serde_json::to_value(v).expect("serializable"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sorts_keys_and_drops_whitespace() {
        let v: Value = serde_json::from_str(r#"{ "b": 1, "a": [true, null, "x"], "c": {"z": 0.0, "y": 9.0} }"#).unwrap();
        assert_eq!(canonicalize(&v), r#"{"a":[true,null,"x"],"b":1,"c":{"y":9,"z":0}}"#);
    }

    #[test]
    fn floats_print_like_javascript() {
        let v: Value = serde_json::from_str(r#"[157.86, 9.0, 0.0, -0.0, 1e21, 1e-7, 12.50, 4.0e2]"#).unwrap();
        assert_eq!(canonicalize(&v), "[157.86,9,0,0,1e+21,1e-7,12.5,400]");
    }

    #[test]
    fn rfc8785_appendix_b_numbers() {
        // Selected IEEE-754 test values from RFC 8785 Appendix B.
        let cases: &[(u64, &str)] = &[
            (0x0000000000000000, "0"),
            (0x8000000000000000, "0"),
            (0x0000000000000001, "5e-324"),
            (0x8000000000000001, "-5e-324"),
            (0x7fefffffffffffff, "1.7976931348623157e+308"),
            (0xffefffffffffffff, "-1.7976931348623157e+308"),
            (0x4340000000000000, "9007199254740992"),
            (0xc340000000000000, "-9007199254740992"),
            (0x4430000000000000, "295147905179352830000"),
            (0x44b52d02c7e14af5, "9.999999999999997e+22"),
            (0x44b52d02c7e14af6, "1e+23"),
            (0x44b52d02c7e14af7, "1.0000000000000001e+23"),
            (0x444b1ae4d6e2ef4e, "999999999999999700000"),
            (0x444b1ae4d6e2ef4f, "999999999999999900000"),
            (0x444b1ae4d6e2ef50, "1e+21"),
            (0x3eb0c6f7a0b5ed8c, "9.999999999999997e-7"),
            (0x3eb0c6f7a0b5ed8d, "0.000001"),
            (0x41b3de4355555553, "333333333.3333332"),
            (0x41b3de4355555554, "333333333.33333325"),
            (0x41b3de4355555555, "333333333.3333333"),
            (0x41b3de4355555556, "333333333.3333334"),
            (0x41b3de4355555557, "333333333.33333343"),
            (0xbecbf647612f3696, "-0.0000033333333333333333"),
            (0x43143ff3c1cb0959, "1424953923781206.2"),
        ];
        for (bits, want) in cases {
            assert_eq!(es_number(f64::from_bits(*bits)), *want, "bits {bits:#018x}");
        }
    }

    #[test]
    fn escapes_like_json_stringify() {
        let v = json!({"s": "a\"b\\c\n\t\u{01}\u{1f}é€😀/"});
        assert_eq!(canonicalize(&v), "{\"s\":\"a\\\"b\\\\c\\n\\t\\u0001\\u001fé€😀/\"}");
    }

    #[test]
    fn utf16_key_order() {
        // U+1F600 (surrogate pair d83d de00) sorts before U+FF61 in UTF-16 but after it in UTF-8.
        let v = json!({"\u{ff61}": 1, "\u{1f600}": 2, "a": 3});
        assert_eq!(canonicalize(&v), "{\"a\":3,\"😀\":2,\"｡\":1}");
    }

    #[test]
    fn large_integers_become_doubles() {
        let v: Value = serde_json::from_str("[9007199254740993, -9007199254740993, 18446744073709551615]").unwrap();
        assert_eq!(canonicalize(&v), "[9007199254740992,-9007199254740992,18446744073709552000]");
    }

    #[test]
    fn hash_is_stable_across_key_order_and_whitespace() {
        let a: Value = serde_json::from_str(r#"{"x": 1.50, "y": [1, 2]}"#).unwrap();
        let b: Value = serde_json::from_str("{\n  \"y\" : [1,2],\n  \"x\" : 1.5\n}").unwrap();
        assert_eq!(canonical_sha256(&a), canonical_sha256(&b));
        assert_eq!(canonical_sha256(&a), sha256_hex(br#"{"x":1.5,"y":[1,2]}"#));
    }
}
