//! settle-core for "Check the math" in the browser.
//!
//! Build: `cargo build --release --target wasm32-unknown-unknown -p settle-wasm`. The module
//! has no imports. JavaScript writes a UTF-8 JSON request into memory from `alloc`, calls
//! `commish_call(ptr, len)`, and reads the response at `(ret >> 32, ret & 0xffffffff)`, then
//! frees both with `dealloc`. See web/src/settle/core.ts.
//!
//! Requests:
//! - `{"op":"initial_urls","input":<JobInput>}` → `{"ok":[url…]}`
//! - `{"op":"followup_urls","input":<JobInput>,"league":<json>}` → `{"ok":[url…]}`
//! - `{"op":"run","input":<JobInput>,"fetched":[[url,json]…],"request_id":"…"|null}` → `{"ok":"<canonical JSON output>"}`
//! - `{"op":"canonical","value":<json>}` → `{"ok":"<canonical JSON>"}`
//! - `{"op":"version"}` → `{"ok":"1.0.0"}`
//!
//! Errors come back as `{"err":"…"}`.

use serde_json::{json, Value};
use settle_core::canonical::{canonicalize, to_canonical_string};
use settle_core::settle::{followup_urls, initial_urls, run};
use settle_core::JobInput;

#[no_mangle]
pub extern "C" fn alloc(len: u32) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len as usize);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` and `len` must come from `alloc` (or a response of `commish_call`).
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: u32) {
    drop(Vec::from_raw_parts(ptr, 0, len as usize));
}

/// # Safety
/// `ptr..ptr+len` must be a request written into memory from `alloc`.
#[no_mangle]
pub unsafe extern "C" fn commish_call(ptr: *const u8, len: u32) -> u64 {
    let req = std::slice::from_raw_parts(ptr, len as usize);
    let resp = handle(req).to_string().into_bytes();
    let mut resp = std::mem::ManuallyDrop::new(resp);
    resp.shrink_to_fit();
    ((resp.as_mut_ptr() as u64) << 32) | resp.len() as u64
}

fn handle(req: &[u8]) -> Value {
    match handle_inner(req) {
        Ok(v) => json!({ "ok": v }),
        Err(e) => json!({ "err": e }),
    }
}

fn input_of(v: &Value) -> Result<JobInput, String> {
    serde_json::from_value(v["input"].clone()).map_err(|e| format!("input: {e}"))
}

fn handle_inner(req: &[u8]) -> Result<Value, String> {
    let v: Value = serde_json::from_slice(req).map_err(|e| format!("request: {e}"))?;
    match v["op"].as_str().unwrap_or("") {
        "version" => Ok(json!(settle_core::CORE_VERSION)),
        "initial_urls" => initial_urls(&input_of(&v)?).map(|u| json!(u)).map_err(|e| e.to_string()),
        "followup_urls" => followup_urls(&input_of(&v)?, &v["league"]).map(|u| json!(u)).map_err(|e| e.to_string()),
        "run" => {
            let input = input_of(&v)?;
            let fetched: Vec<(String, Value)> = v["fetched"]
                .as_array()
                .ok_or("fetched must be [[url, json], …]")?
                .iter()
                .map(|p| (p[0].as_str().unwrap_or("").to_string(), p[1].clone()))
                .collect();
            let request_id = v["request_id"].as_str().map(|s| s.to_string());
            Ok(json!(to_canonical_string(&run(&input, &fetched, request_id))))
        }
        "canonical" => Ok(json!(canonicalize(&v["value"]))),
        op => Err(format!("unknown op {op:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_through_the_abi() {
        let req = br#"{"op":"canonical","value":{"b":9.0,"a":[0.0]}}"#;
        let resp = handle(req);
        assert_eq!(resp, json!({ "ok": "{\"a\":[0],\"b\":9}" }));
        let resp = handle(br#"{"op":"nope"}"#);
        assert!(resp["err"].as_str().unwrap().contains("unknown op"));
    }
}
