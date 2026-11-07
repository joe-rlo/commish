#!/bin/sh
# Builds the enclave job reproducibly: same bytes (and SHA-256) on any machine with the pinned
# toolchain (rust-toolchain.toml). Machine-specific paths are remapped so they do not end up in
# the wasm (Rust embeds source paths in panic locations).
set -eu
cd "$(dirname "$0")/.."
CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export RUSTFLAGS="--remap-path-prefix=$CARGO_HOME/registry/src=/cargo/registry/src --remap-path-prefix=$(pwd)=/commish"
cargo build --release --locked -p outlayer-job --target wasm32-wasip2 --target-dir target/job
WASM=target/job/wasm32-wasip2/release/outlayer-job.wasm
if strings "$WASM" | grep -q -e "$HOME" -e "$(pwd)"; then echo "machine-specific path left in $WASM" >&2; exit 1; fi
shasum -a 256 "$WASM" | cut -d" " -f1
