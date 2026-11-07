// Sign-in: a quick testnet account (key stays in this browser) or a NEAR wallet.
//
// Paying dues needs a full-access key or a wallet (NEP-141 transfers attach 1 yoctoNEAR, and
// function-call keys can't attach deposits), so quick accounts hold a full-access key.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Account, KeyPair, type KeyPairString } from "near-api-js";
import { config } from "./config";
import { provider } from "./near";
import { worker } from "./worker";

export interface CallParams {
  contractId: string;
  method: string;
  args: Record<string, unknown>;
  deposit?: bigint;
  gas?: bigint;
}
export interface CallResult {
  txHash: string;
  value: unknown;
}
export interface Signer {
  accountId: string;
  kind: "quick" | "wallet";
  call(p: CallParams): Promise<CallResult>;
}

const STORE = "commish:quick-account";
const TGAS = 1_000_000_000_000n;

interface Stored {
  accountId: string;
  secretKey: string;
}

function readStored(): Stored | null {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

function decodeValue(status: unknown): unknown {
  const s = status as { SuccessValue?: string; Failure?: unknown };
  if (s && "Failure" in s && s.Failure) throw new Error(failureText(s.Failure));
  if (!s?.SuccessValue) return null;
  try {
    return JSON.parse(atob(s.SuccessValue));
  } catch {
    return null;
  }
}

/** Turns a NEAR failure into the contract's own message when there is one. */
export function failureText(f: unknown): string {
  const text = JSON.stringify(f);
  const m = text.match(/Smart contract panicked: ([^"\\]+)/) || text.match(/"ExecutionError":"([^"]+)"/);
  if (m) return m[1]!.replace(/^Smart contract panicked: /, "");
  if (text.includes("NotEnoughBalance") || text.includes("LackBalanceForState")) return "This account doesn't have enough testnet NEAR for that.";
  return "The transaction failed.";
}

function quickSigner(s: Stored): Signer {
  const account = new Account(s.accountId, provider, s.secretKey as KeyPairString);
  return {
    accountId: s.accountId,
    kind: "quick",
    async call({ contractId, method, args, deposit = 0n, gas = 100n * TGAS }) {
      try {
        const res = await account.callFunctionRaw({ contractId, methodName: method, args, deposit, gas, waitUntil: "EXECUTED_OPTIMISTIC" });
        return { txHash: res.transaction.hash, value: decodeValue(res.status) };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/NotEnoughBalance|balance/i.test(msg)) throw new Error("This account doesn't have enough testnet NEAR for that.");
        throw e instanceof Error ? new Error(failureText(msg) === "The transaction failed." ? msg : failureText(msg)) : e;
      }
    },
  };
}

// The wallet connector is loaded only when someone picks "Use a NEAR wallet".
type Connector = import("@hot-labs/near-connect").NearConnector;
let connectorPromise: Promise<Connector> | null = null;
function getConnector(): Promise<Connector> {
  connectorPromise ??= import("@hot-labs/near-connect").then(
    ({ NearConnector }) => new NearConnector({ network: "testnet", providers: { testnet: [config.rpcUrl] } }),
  );
  return connectorPromise;
}

function walletSigner(accountId: string, connector: Connector): Signer {
  return {
    accountId,
    kind: "wallet",
    async call({ contractId, method, args, deposit = 0n, gas = 100n * TGAS }) {
      const wallet = await connector.wallet();
      const outcome = await wallet.signAndSendTransaction({
        receiverId: contractId,
        actions: [{ type: "FunctionCall", params: { methodName: method, args, gas: gas.toString(), deposit: deposit.toString() } }],
      });
      const o = outcome as unknown as { transaction?: { hash: string }; transaction_outcome?: { id: string }; status: unknown };
      return { txHash: o.transaction?.hash ?? o.transaction_outcome?.id ?? "", value: decodeValue(o.status) };
    },
  };
}

interface AuthState {
  signer: Signer | null;
  ready: boolean;
  /** Creates `<name>.<root>` with a key generated here, funded by the Commish service. */
  createQuickAccount(name: string): Promise<Signer>;
  connectWallet(): Promise<Signer | null>;
  signOut(): Promise<void>;
  /** The quick account's private key, for Export. */
  exportKey(): string | null;
  sheetOpen: boolean;
  openSignIn(then?: (s: Signer) => void): void;
  closeSignIn(): void;
  onSignedIn: ((s: Signer) => void) | null;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [signer, setSigner] = useState<Signer | null>(() => {
    const s = readStored();
    return s ? quickSigner(s) : null;
  });
  const [ready, setReady] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [onSignedIn, setOnSignedIn] = useState<((s: Signer) => void) | null>(null);

  useEffect(() => {
    // Restore a wallet session if there's no quick account.
    if (readStored()) return setReady(true);
    const hadWallet = localStorage.getItem("commish:wallet") === "1";
    if (!hadWallet) return setReady(true);
    getConnector()
      .then(async (c) => {
        const { accounts } = await c.getConnectedWallet();
        if (accounts[0]) setSigner(walletSigner(accounts[0].accountId, c));
      })
      .catch(() => localStorage.removeItem("commish:wallet"))
      .finally(() => setReady(true));
  }, []);

  const finish = useCallback(
    (s: Signer) => {
      setSigner(s);
      setSheetOpen(false);
      const cb = onSignedIn;
      setOnSignedIn(null);
      if (cb) setTimeout(() => cb(s), 0);
      return s;
    },
    [onSignedIn],
  );

  const createQuickAccount = useCallback(
    async (name: string) => {
      const kp = KeyPair.fromRandom("ed25519");
      const { account_id } = await worker.createAccount(name, kp.getPublicKey().toString());
      const stored = { accountId: account_id, secretKey: kp.toString() };
      localStorage.setItem(STORE, JSON.stringify(stored));
      return finish(quickSigner(stored));
    },
    [finish],
  );

  const connectWallet = useCallback(async () => {
    const c = await getConnector();
    const wallet = await c.connect();
    const accounts = await wallet.getAccounts();
    if (!accounts[0]) return null;
    localStorage.setItem("commish:wallet", "1");
    return finish(walletSigner(accounts[0].accountId, c));
  }, [finish]);

  const signOut = useCallback(async () => {
    if (signer?.kind === "wallet") {
      const c = await getConnector();
      await c.disconnect().catch(() => {});
      localStorage.removeItem("commish:wallet");
    } else {
      localStorage.removeItem(STORE);
    }
    setSigner(null);
  }, [signer]);

  const value = useMemo<AuthState>(
    () => ({
      signer,
      ready,
      createQuickAccount,
      connectWallet,
      signOut,
      exportKey: () => readStored()?.secretKey ?? null,
      sheetOpen,
      openSignIn: (then) => {
        setOnSignedIn(() => then ?? null);
        setSheetOpen(true);
      },
      closeSignIn: () => {
        setSheetOpen(false);
        setOnSignedIn(null);
      },
      onSignedIn,
    }),
    [signer, ready, createQuickAccount, connectWallet, signOut, sheetOpen, onSignedIn],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}

/** Runs `fn` with a signer, asking the person to sign in first if needed. */
export function useWithSigner() {
  const { signer, openSignIn } = useAuth();
  return useCallback(
    (fn: (s: Signer) => void) => {
      if (signer) fn(signer);
      else openSignIn(fn);
    },
    [signer, openSignIn],
  );
}
