//! Entry point. Inside OutLayer: reads the input on stdin, fetches Sleeper over WASI HTTP,
//! prints canonical JSON on stdout. Natively: the same, over ureq.

use std::io::{Read, Write};

/// The outbound allowlist the OutLayer worker enforces (wasm custom section
/// `outlayer.manifest`, covered by the wasm hash the contract pins): Sleeper only.
#[cfg(target_family = "wasm")]
#[used]
#[link_section = "outlayer.manifest"]
static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] = *include_bytes!("../manifest.json");

#[cfg(target_os = "wasi")]
mod wasi_fetch {
    use outlayer_job::{response_json, Fetch, FetchError};
    use serde_json::Value;
    use std::time::Duration;

    pub struct WasiFetch;

    impl Fetch for WasiFetch {
        fn get_json(&mut self, url: &str) -> Result<Value, FetchError> {
            let resp = wasi_http_client::Client::new()
                .get(url)
                .header("accept", "application/json")
                .connect_timeout(Duration::from_secs(10))
                .send()
                .map_err(|e| FetchError(format!("{url}: {e}")))?;
            let status = resp.status();
            let body = resp.body().map_err(|e| FetchError(format!("{url}: {e}")))?;
            response_json(url, status, &body)
        }
    }
}

fn main() {
    let mut stdin = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut stdin) {
        eprintln!("can't read stdin: {e}");
        std::process::exit(2);
    }
    // OutLayer sets NEAR_REQUEST_ID for on-chain runs; receipts use it to find the attestation.
    let request_id = std::env::var("NEAR_REQUEST_ID").ok().filter(|s| !s.is_empty());

    #[cfg(target_os = "wasi")]
    let mut fetch = wasi_fetch::WasiFetch;
    #[cfg(not(target_family = "wasm"))]
    let mut fetch = outlayer_job::native::UreqFetch::default();

    let out = outlayer_job::run_job(&stdin, &mut fetch, request_id);
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(out.as_bytes());
    let _ = stdout.flush();
}
