// Page chrome: header with the Testnet badge and sign-in, the sign-in sheet, the account sheet.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink } from "react-router";
import { useAuth } from "../lib/auth";
import { accountUrl, config } from "../lib/config";
import { ErrorNote, Spinner } from "./bits";

export function Shell({ children }: { children: ReactNode }) {
  const { signer, openSignIn } = useAuth();
  const [accountOpen, setAccountOpen] = useState(false);
  return (
    <div className="mx-auto flex min-h-dvh max-w-[640px] flex-col px-4">
      <a href="#main" className="sr-only focus:not-sr-only">Skip to content</a>
      <header className="flex items-center justify-between gap-3 py-3">
        <Link to="/" className="flex min-h-11 items-center gap-2" aria-label="Commish home">
          <span className="display text-[1.6rem]">Commish</span>
          <span className="rounded-md border-2 border-hold px-1.5 py-0.5 text-xs font-bold text-hold" title="Everything here runs on NEAR testnet with test money">
            Testnet
          </span>
        </Link>
        {signer ? (
          <button type="button" className="btn btn-ghost max-w-[11rem] px-3" onClick={() => setAccountOpen(true)}>
            <span className="truncate">{signer.accountId.split(".")[0]}</span>
          </button>
        ) : (
          <button type="button" className="btn btn-ink" onClick={() => openSignIn()}>
            Sign in
          </button>
        )}
      </header>
      <main id="main" className="flex-1 pb-16">
        {children}
      </main>
      <footer className="border-t border-line py-6 text-sm text-muted">
        <nav className="flex flex-wrap gap-x-5">
          <NavLink to="/how" className="inline-flex min-h-11 items-center underline-offset-4 hover:underline">How it works</NavLink>
          <NavLink to="/demo" className="inline-flex min-h-11 items-center underline-offset-4 hover:underline">Demo league</NavLink>
          <NavLink to="/new" className="inline-flex min-h-11 items-center underline-offset-4 hover:underline">Start a league</NavLink>
        </nav>
        <p className="mt-3 max-w-prose">
          A NEAR testnet demo built at NEAR HACKATHON. Test money only. Paid fantasy is regulated differently by state and country.
        </p>
      </footer>
      <SignInSheet />
      {accountOpen && <AccountSheet onClose={() => setAccountOpen(false)} />}
    </div>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input, button")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="sheet-backdrop fixed inset-0 z-50 flex items-end justify-center sm:items-center" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-[480px] rounded-t-3xl bg-paper p-5 pb-8 shadow-2xl sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="display text-3xl">{title}</h2>
          <button type="button" className="btn btn-ghost px-3" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const NAME_RE = /^[a-z0-9]{2,20}$/;

function SignInSheet() {
  const { sheetOpen, closeSignIn, createQuickAccount, connectWallet } = useAuth();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"quick" | "wallet" | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (!sheetOpen) return null;
  const clean = name.trim().toLowerCase();
  const valid = NAME_RE.test(clean);
  return (
    <Sheet title="Sign in" onClose={closeSignIn}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!valid) return;
          setBusy("quick");
          setError(null);
          try {
            await createQuickAccount(clean);
            setName("");
          } catch (err) {
            setError(err);
          } finally {
            setBusy(null);
          }
        }}
      >
        <label htmlFor="quick-name" className="block font-bold">
          Quick account
        </label>
        <p className="text-sm text-muted">Pick a name. No app, no seed phrase. Your key stays in this browser.</p>
        <div className="flex gap-2">
          <input
            id="quick-name"
            className="field"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="text"
            placeholder="e.g. waiverwire"
            value={name}
            maxLength={20}
            onChange={(e) => setName(e.target.value)}
            aria-describedby="quick-name-hint"
          />
          <button type="submit" className="btn btn-money" disabled={!valid || busy !== null}>
            {busy === "quick" ? <Spinner /> : "Create"}
          </button>
        </div>
        <p id="quick-name-hint" className="text-sm text-muted">
          {clean && !valid ? "2 to 20 lowercase letters or numbers." : clean ? `You'll be ${clean}.${config.rootAccountId}` : "Lowercase letters and numbers."}
        </p>
      </form>
      <div className="my-5 flex items-center gap-3 text-sm text-muted">
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-block"
        disabled={busy !== null}
        onClick={async () => {
          setBusy("wallet");
          setError(null);
          try {
            await connectWallet();
          } catch (err) {
            setError(err);
          } finally {
            setBusy(null);
          }
        }}
      >
        {busy === "wallet" ? <Spinner label="Opening your wallet" /> : "Use a NEAR wallet"}
      </button>
      <div className="mt-4">
        <ErrorNote error={error} />
      </div>
    </Sheet>
  );
}

function AccountSheet({ onClose }: { onClose: () => void }) {
  const { signer, signOut, exportKey } = useAuth();
  const [shown, setShown] = useState(false);
  if (!signer) return null;
  const key = signer.kind === "quick" ? exportKey() : null;
  return (
    <Sheet title="Your account" onClose={onClose}>
      <p className="mono break-all">{signer.accountId}</p>
      <p className="mt-1 text-sm text-muted">{signer.kind === "quick" ? "Quick account on NEAR testnet" : "NEAR wallet (testnet)"}</p>
      <a href={accountUrl(signer.accountId)} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm underline underline-offset-4">
        View on the testnet explorer
      </a>
      {key && (
        <div className="mt-5 space-y-2">
          <h3 className="font-bold">Export key</h3>
          <p className="text-sm text-muted">This key controls the account. Anyone with it can spend from it. It only leaves this browser if you copy it.</p>
          {shown ? (
            <div className="space-y-2">
              <p className="mono break-all rounded-xl border-2 border-line bg-surface p-3">{key}</p>
              <button type="button" className="btn btn-ghost" onClick={() => navigator.clipboard?.writeText(key)}>
                Copy key
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={() => setShown(true)}>
              Show key
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        className="btn btn-stop btn-block mt-6"
        onClick={async () => {
          if (signer.kind === "quick" && !confirm("Signing out deletes this browser's copy of the key. Export it first if you want to keep the account.")) return;
          await signOut();
          onClose();
        }}
      >
        Sign out
      </button>
    </Sheet>
  );
}
