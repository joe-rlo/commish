//! settle-core: the Commish payout rules (SPEC.md section 6).
//!
//! Pure functions. No network, no clock: every input, including `now`, is passed in.
//! The same source compiles to three targets:
//!   1. native (unit tests, `commish-verify`)
//!   2. `wasm32-wasip2` inside `outlayer-job` (the attested enclave run)
//!   3. `wasm32-unknown-unknown` inside `settle-wasm` ("Check the math" in the browser)
//!
//! The commish contract also links this crate (with `default-features = false`) for the
//! amount math that needs on-chain state: season amounts from the vault balance and
//! withholding. So every number Commish pays comes from this crate.

pub mod amounts;
pub mod finality;
pub mod num;
pub mod types;

#[cfg(feature = "sleeper")]
pub mod canonical;
#[cfg(feature = "sleeper")]
pub mod settle;
#[cfg(feature = "sleeper")]
pub mod sleeper;

pub use types::*;

/// Version of the rules. The contract pins it and rejects results computed by any other version.
pub const CORE_VERSION: &str = "1.0.0";

/// Base URL of the public Sleeper API.
pub const SLEEPER_API: &str = "https://api.sleeper.app/v1";
