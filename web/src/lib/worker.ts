// The Commish Worker: quick accounts, the Test USDC faucet, 1Click preview quotes.
// It never sees a private key: the browser sends only the public key it generated.
import { config } from "./config";

async function post<T>(path: string, body: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${config.workerUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Couldn't reach the Commish service. Check your connection and try again.");
  }
  const j = (await r.json().catch(() => ({}))) as { error?: string } & T;
  if (!r.ok) throw new Error(j.error || `The Commish service answered ${r.status}.`);
  return j;
}

export const worker = {
  createAccount: (name: string, publicKey: string) =>
    post<{ account_id: string; tx: string }>("/accounts", { name, public_key: publicKey }),
  faucet: (accountId: string) => post<{ minted: string; tx: string }>("/faucet", { account_id: accountId }),
  sponsorLeague: (accountId: string) => post<{ sent: string; tx: string }>("/sponsor", { account_id: accountId }),
  quote: (originAsset: string, usdcAmount: string) =>
    post<{ quote: { amountInFormatted: string; amountInUsd: string; minAmountIn?: string; timeEstimate: number; amountOutFormatted: string } }>(
      "/quote",
      { origin_asset: originAsset, amount: usdcAmount },
    ),
};
