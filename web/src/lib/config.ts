// Public configuration (no secrets). Defaults are the Commish testnet deployment.
const env = import.meta.env;

export const config = {
  network: "testnet" as const,
  rpcUrl: env.VITE_RPC_URL || "https://test.rpc.fastnear.com",
  contractId: env.VITE_COMMISH_CONTRACT_ID || "commish.commishhq.testnet",
  usdcId: env.VITE_USDC_ID || "usdc.commishhq.testnet",
  workerUrl: (env.VITE_WORKER_URL || "http://localhost:8787").replace(/\/$/, ""),
  rootAccountId: env.VITE_ROOT_ACCOUNT_ID || "commishhq.testnet",
  outlayerApi: "https://testnet-api.outlayer.ai",
  outlayerApp: "https://app.outlayer.ai",
  explorer: "https://testnet.nearblocks.io",
};

if (env.VITE_NETWORK && env.VITE_NETWORK !== "testnet") {
  throw new Error("This build runs on NEAR testnet only.");
}

export const txUrl = (h: string) => `${config.explorer}/txns/${h}`;
export const accountUrl = (a: string) => `${config.explorer}/address/${a}`;
export const attestationUrl = (requestId: string) => `${config.outlayerApi}/attestations/by-request/${requestId}`;
export const attestationAppUrl = (requestId: string) => `${config.outlayerApp}/attestations/by-request/${requestId}`;
