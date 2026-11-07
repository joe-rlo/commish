//! The settlement job, independent of how HTTP is done.
//!
//! `run_job` reads the contract's input, fetches the Sleeper URLs that settle-core asks
//! for, runs settle-core, and returns the result as canonical JSON (RFC 8785). The same
//! function runs inside the OutLayer enclave and in `commish-verify`.

use serde_json::Value;
use settle_core::canonical::to_canonical_string;
use settle_core::settle::{followup_urls, initial_urls, run};
use settle_core::{ErrorCode, JobInput, JobOutput, SettleError};

/// One HTTP GET of a Sleeper URL, parsed as JSON.
pub trait Fetch {
    fn get_json(&mut self, url: &str) -> Result<Value, FetchError>;
}

#[derive(Debug)]
pub struct FetchError(pub String);

/// Turns an HTTP response into JSON. Sleeper answers unknown ids with 404 and a `null`
/// body, which settle-core reports as "league not found".
pub fn response_json(url: &str, status: u16, body: &[u8]) -> Result<Value, FetchError> {
    let parsed: Result<Value, _> = serde_json::from_slice(body);
    match (status, parsed) {
        (200..=299, Ok(v)) => Ok(v),
        (404, Ok(Value::Null)) => Ok(Value::Null),
        (200..=299, Err(e)) => Err(FetchError(format!("{url}: response isn't JSON ({e})"))),
        (s, _) => Err(FetchError(format!("{url}: HTTP {s}"))),
    }
}

/// Fetches everything a settlement needs, in the order settle-core plans it.
pub fn fetch_all(input: &JobInput, fetch: &mut dyn Fetch) -> Result<Vec<(String, Value)>, SettleError> {
    let unreachable = |e: FetchError| SettleError::new(ErrorCode::SleeperUnreachable, e.0);
    let mut fetched = Vec::new();
    for url in initial_urls(input)? {
        let v = fetch.get_json(&url).map_err(unreachable)?;
        fetched.push((url, v));
    }
    let league = fetched[0].1.clone();
    for url in followup_urls(input, &league)? {
        let v = fetch.get_json(&url).map_err(unreachable)?;
        fetched.push((url, v));
    }
    Ok(fetched)
}

/// Runs the whole job and returns the output object.
pub fn run_output(input: &JobInput, fetch: &mut dyn Fetch, request_id: Option<String>) -> JobOutput {
    match fetch_all(input, fetch) {
        Ok(fetched) => run(input, &fetched, request_id),
        Err(e) => JobOutput::from_result(input, Err(e), request_id),
    }
}

/// Runs the job on raw stdin text and returns canonical JSON for stdout.
pub fn run_job(stdin: &str, fetch: &mut dyn Fetch, request_id: Option<String>) -> String {
    let input: JobInput = match serde_json::from_str(stdin) {
        Ok(i) => i,
        Err(e) => {
            // No input to echo back: print a bare error the contract records as a failure.
            let v = serde_json::json!({
                "core_version": settle_core::CORE_VERSION,
                "error": { "code": ErrorCode::BadInput.as_str(), "message": format!("input: {e}") },
            });
            return settle_core::canonical::canonicalize(&v);
        }
    };
    to_canonical_string(&run_output(&input, fetch, request_id))
}

/// Native HTTP (for `commish-verify` and local runs).
#[cfg(not(target_family = "wasm"))]
pub mod native {
    use super::{response_json, Fetch, FetchError};
    use serde_json::Value;

    pub struct UreqFetch {
        agent: ureq::Agent,
    }

    impl Default for UreqFetch {
        fn default() -> Self {
            let config = ureq::Agent::config_builder()
                .timeout_global(Some(std::time::Duration::from_secs(30)))
                .http_status_as_error(false)
                .build();
            UreqFetch { agent: config.new_agent() }
        }
    }

    impl Fetch for UreqFetch {
        fn get_json(&mut self, url: &str) -> Result<Value, FetchError> {
            let mut resp = self
                .agent
                .get(url)
                .header("accept", "application/json")
                .call()
                .map_err(|e| FetchError(format!("{url}: {e}")))?;
            let status = resp.status().as_u16();
            let body = resp
                .body_mut()
                .with_config()
                .limit(8 * 1024 * 1024)
                .read_to_vec()
                .map_err(|e| FetchError(format!("{url}: {e}")))?;
            response_json(url, status, &body)
        }
    }
}

/// Serves recorded responses (tests and offline checks).
pub struct MapFetch(pub Vec<(String, Value)>);

impl Fetch for MapFetch {
    fn get_json(&mut self, url: &str) -> Result<Value, FetchError> {
        self.0
            .iter()
            .find(|(u, _)| u == url)
            .map(|(_, v)| v.clone())
            .ok_or_else(|| FetchError(format!("{url}: not recorded")))
    }
}
