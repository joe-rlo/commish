# Deployed contract bytes used by the sandbox tests

Downloaded from NEAR testnet with RPC `view_code` on 2026-11-07, so the tests run the exact code
the demo depends on.

| File | Account | SHA-256 | NEAR code hash |
| --- | --- | --- | --- |
| `sputnik-factory-testnet.wasm` | `sputnik-v2.testnet` | `b3ff84de77a7a04c21e3cf67a3dfc22b08ed41ee039bbe598b75a185a8b56a25` | `D7dxhAZvwPQ9aUfpXANGXQdWGy9pkQ4UKM4v2YGe7yVE` |
| `sputnik-dao-testnet.wasm` | a DAO created by that factory (`jk-warden-dao.sputnik-v2.testnet`) | `084441471c11099d78e2eecda571dd4d8c29153282807edd415935c97355dd56` | `ZGdM2TFdQpcXrxPxvq25514EViyi9xBSboetDiB3Uiq` |
| `outlayer-testnet.wasm` | `outlayer.testnet` | `74ab074a27ccddd9b6f400f3f8453c1039419acba556ba77dfb288759b3dbd0f` | — |

Re-download and compare:

```sh
curl -s https://rpc.testnet.near.org -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_code","finality":"final","account_id":"sputnik-v2.testnet"}}' \
  | jq -r .result.code_base64 | base64 -d | shasum -a 256
```
