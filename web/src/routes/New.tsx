// Create a league (SPEC 5.2): find it on Sleeper, set the rules, create the vault, share the invite.
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { avatarUrl, createDeposit, dollars, loadLeague, money, parseDollars, parseLeagueInput, splitWords } from "@commish/shared";
import { Avatar, ErrorNote, Spinner } from "../components/bits";
import * as act from "../lib/actions";
import { useAuth, useWithSigner, type Signer } from "../lib/auth";
import { accountUrl, config, txUrl } from "../lib/config";
import { accountExists, commish, nearBalance } from "../lib/near";
import { useConfig } from "../lib/queries";
import { worker } from "../lib/worker";

type Found = NonNullable<Awaited<ReturnType<typeof loadLeague>>>;

const PRESETS: { label: string; split: number[] }[] = [
  { label: "Winner takes all", split: [100] },
  { label: "70/30", split: [70, 30] },
  { label: "60/25/15", split: [60, 25, 15] },
];

export function NewLeague() {
  const [found, setFound] = useState<Found | null>(null);
  const [created, setCreated] = useState<{ leagueId: number; name: string } | null>(null);
  if (created) return <Invite {...created} />;
  return (
    <div className="pt-4">
      <h1 className="display text-[3rem] leading-none">Start a league</h1>
      <Find found={found} onFound={setFound} />
      {found && <Rules found={found} onCreated={setCreated} />}
    </div>
  );
}

function Find({ found, onFound }: { found: Found | null; onFound: (f: Found | null) => void }) {
  const [sp] = useSearchParams();
  const allowComplete = sp.get("demo") === "1";
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    const id = parseLeagueInput(text);
    if (!id) return setError("Paste a Sleeper league link (sleeper.com/leagues/…) or the league ID.");
    setBusy(true);
    try {
      const f = await loadLeague(id);
      if (!f) return setError("Sleeper has no league with that ID. Check the link and try again.");
      if (f.league.sport !== "nfl") return setError("That's not an NFL league. Commish works with Sleeper NFL leagues.");
      if (f.rosters.length < 2) return setError("That league has fewer than 2 teams.");
      if (f.league.status === "complete" && !allowComplete) return setError("That season is already over. Pick a league that's still playing.");
      onFound(f);
    } catch {
      setError("Couldn't reach Sleeper. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="find-h" className="mt-6">
      <h2 id="find-h" className="display text-3xl">Find your league</h2>
      <form className="mt-3" onSubmit={(e) => (e.preventDefault(), submit())}>
        <label htmlFor="league-link" className="font-bold">Paste your Sleeper league link or ID</label>
        <p className="text-sm text-muted">Open your league on sleeper.com and copy the address bar.</p>
        <div className="mt-2 flex gap-2">
          <input id="league-link" className="field" placeholder="sleeper.com/leagues/…" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" inputMode="url" />
          <button type="submit" className="btn btn-ink" disabled={busy || !text.trim()}>{busy ? <Spinner /> : "Find"}</button>
        </div>
      </form>
      {error && (
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      )}
      {found && (
        <div className="mt-4 rounded-2xl border-2 border-line bg-surface p-4">
          <div className="flex items-center gap-3">
            <Avatar src={avatarUrl(found.league.avatar)} name={found.league.name} size={56} />
            <div>
              <p className="display text-2xl leading-none">{found.league.name}</p>
              <p className="text-muted">{found.league.season} season · {found.rosters.length} teams</p>
            </div>
          </div>
          <ul className="mt-3 grid grid-cols-4 gap-2 sm:grid-cols-6" aria-label="Teams">
            {found.teams.map((t) => (
              <li key={t.roster_id} className="flex min-w-0 flex-col items-center gap-1 text-center">
                <Avatar src={t.avatar} name={t.name} size={40} />
                <span className="w-full truncate text-xs">{t.name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Rules({ found, onCreated }: { found: Found; onCreated: (c: { leagueId: number; name: string }) => void }) {
  const cfg = useConfig();
  const { signer } = useAuth();
  const withSigner = useWithSigner();
  const n = found.rosters.length;
  const rsw = Math.max(1, (found.league.settings.playoff_week_start ?? 15) - 1);
  const [dues, setDues] = useState("50");
  const [weeklyOn, setWeeklyOn] = useState(true);
  const [weekly, setWeekly] = useState("5");
  const [split, setSplit] = useState<number[]>([60, 25, 15]);
  const [custom, setCustom] = useState(false);
  const [hold, setHold] = useState("24");
  const [withhold, setWithhold] = useState(true);
  const [progress, setProgress] = useState<Step[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const duesU = parseDollars(dues);
  const weeklyU = weeklyOn ? parseDollars(weekly) : 0n;
  const holdH = Number(hold);
  const issues = useMemo(() => {
    const out: string[] = [];
    if (duesU === null || duesU < 1_000_000n || duesU > 10_000_000_000n) out.push("Dues must be $1 to $10,000.");
    if (weeklyU === null) out.push("The weekly payout must be a dollar amount.");
    if (duesU !== null && weeklyU !== null && weeklyU * BigInt(rsw) > duesU * BigInt(n)) out.push("Weekly payouts for the whole season don't fit in the pot.");
    if (split.length < 1 || split.length > 3 || split.some((x) => !Number.isInteger(x) || x <= 0) || split.reduce((a, b) => a + b, 0) !== 100)
      out.push("The season split needs 1 to 3 places that add up to 100.");
    if (!Number.isInteger(holdH) || holdH < 1 || holdH > 72) out.push("The hold window must be 1 to 72 hours.");
    return out;
  }, [duesU, weeklyU, rsw, n, split, holdH]);

  const pot = duesU !== null ? duesU * BigInt(n) : 0n;
  const weeklyTotal = (weeklyU ?? 0n) * BigInt(rsw);
  const rest = pot > weeklyTotal ? pot - weeklyTotal : 0n;

  const create = async (s: Signer) => {
    if (!cfg.data || issues.length) return;
    setError(null);
    const steps: Step[] = [
      { label: "Creating your league's vault", state: "active" },
      { label: "Setting up USDC", state: "todo" },
      { label: "Done", state: "todo" },
    ];
    setProgress(steps);
    try {
      const need = createDeposit(cfg.data) + 400_000_000_000_000_000_000_000n; // + room for gas
      if ((await nearBalance(s.accountId)) < need) {
        if (s.kind !== "quick") throw new Error(`Creating a league needs about ${(Number(need) / 1e24).toFixed(1)} testnet NEAR for the vault's storage. Add testnet NEAR to your wallet and try again.`);
        await worker.sponsorLeague(s.accountId);
      }
      const isDemo = s.accountId === cfg.data.demo_admin && found.league.status === "complete";
      const { leagueId, txHash } = await act.createLeague(s, cfg.data, {
        sleeper_league_id: found.league.league_id,
        season: found.league.season,
        name: found.league.name,
        rosters: found.rosters.map((r) => ({ roster_id: r.roster_id, sleeper_owner_id: r.owner_id })),
        dues: duesU!.toString(),
        weekly_amount: (weeklyU ?? 0n).toString(),
        regular_season_weeks: rsw,
        season_split_bps: split.map((x) => x * 100),
        hold_window_ns: (BigInt(isDemo ? 60 : holdH * 3600) * 1_000_000_000n).toString(),
        withhold_unpaid: withhold,
        is_demo: isDemo,
      });
      const vaultId = `${cfg.data.vault_name_prefix}${leagueId}.${cfg.data.sputnik_factory_id}`;
      steps[0] = { ...steps[0]!, tx: txHash };
      setProgress([...steps]);
      for (let i = 0; i < 60; i++) {
        const [exists, l] = await Promise.all([accountExists(vaultId), commish.league(leagueId)]);
        if (exists && steps[0]!.state !== "done") {
          steps[0] = { ...steps[0]!, state: "done", href: accountUrl(vaultId) };
          steps[1] = { ...steps[1]!, state: "active" };
          setProgress([...steps]);
        }
        if (l?.status === "Failed") throw new Error("The vault couldn't be created. Your deposit was returned.");
        if (l?.status === "Active") {
          steps[0] = { ...steps[0]!, state: "done", href: accountUrl(vaultId) };
          steps[1] = { ...steps[1]!, state: "done", href: accountUrl(config.usdcId) };
          steps[2] = { ...steps[2]!, state: "done" };
          setProgress([...steps]);
          setTimeout(() => onCreated({ leagueId, name: found.league.name }), 700);
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Error("Creating the vault is taking longer than usual. Check the league page in a minute.");
    } catch (e) {
      setError(e);
      setProgress(null);
    }
  };

  return (
    <section aria-labelledby="rules-h" className="mt-10 space-y-6">
      <h2 id="rules-h" className="display text-3xl">Set the rules</h2>
      <Money id="dues" label="Dues per team" value={dues} onChange={setDues} />
      <div className="space-y-2">
        <label className="flex min-h-11 items-center gap-3 font-bold">
          <input type="checkbox" className="size-5 accent-[var(--money)]" checked={weeklyOn} onChange={(e) => setWeeklyOn(e.target.checked)} />
          Weekly high score payout
        </label>
        {weeklyOn && <Money id="weekly" label="Each week's high score wins" value={weekly} onChange={setWeekly} />}
      </div>
      <fieldset className="space-y-2">
        <legend className="font-bold">Season split</legend>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button key={p.label} type="button" aria-pressed={!custom && split.join() === p.split.join()} className={`btn ${!custom && split.join() === p.split.join() ? "btn-ink" : "btn-ghost"}`} onClick={() => (setCustom(false), setSplit(p.split))}>
              {p.label}
            </button>
          ))}
          <button type="button" aria-pressed={custom} className={`btn ${custom ? "btn-ink" : "btn-ghost"}`} onClick={() => setCustom(true)}>Custom</button>
        </div>
        {custom && (
          <div className="flex gap-2">
            {[0, 1, 2].map((i) => (
              <label key={i} className="flex-1">
                <span className="text-sm text-muted">{["1st", "2nd", "3rd"][i]} %</span>
                <input
                  className="field tnum"
                  inputMode="numeric"
                  value={split[i] ?? ""}
                  onChange={(e) => {
                    const v = e.target.value.replace(/\D/g, "");
                    const next = [...split];
                    next[i] = v === "" ? 0 : Number(v);
                    setSplit(next.slice(0, 3).filter((x, j) => x > 0 || j < 1));
                  }}
                />
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <label className="block">
        <span className="font-bold">Hold window (hours)</span>
        <span className="block text-sm text-muted">How long the league has to stop a payout before it's sent. 1 to 72.</span>
        <input className="field tnum mt-1 w-32" inputMode="numeric" value={hold} onChange={(e) => setHold(e.target.value.replace(/\D/g, ""))} />
      </label>
      <label className="flex min-h-11 items-center gap-3 font-bold">
        <input type="checkbox" className="size-5 accent-[var(--money)]" checked={withhold} onChange={(e) => setWithhold(e.target.checked)} />
        Withhold winnings until dues are paid
      </label>

      <div className="board p-4">
        <p className="tnum text-board-ink">
          {n} teams × {money(duesU ?? 0n)} = <b className="text-lamp">{money(pot)}</b> pot
          {weeklyU ? ` · ${money(weeklyTotal)} in weekly payouts (${money(weeklyU)} × ${rsw} regular-season weeks)` : ""} · {money(rest)} split {splitWords(split.map((x) => x * 100))} at season's end.
        </p>
      </div>
      <p className="text-sm text-muted">Rules lock once the first team pays.</p>
      {issues.length > 0 && (
        <ul className="space-y-1 text-sm font-bold text-stop" role="alert">
          {issues.map((i) => <li key={i}>{i}</li>)}
        </ul>
      )}
      <ErrorNote error={error} />
      {progress ? (
        <ol className="space-y-2" aria-live="polite">
          {progress.map((st) => (
            <li key={st.label} className="flex min-h-11 items-center gap-3">
              {st.state === "done" ? <Check /> : st.state === "active" ? <span className="spinner text-money" aria-hidden /> : <span className="size-5 rounded-full border-2 border-line" aria-hidden />}
              <span className={st.state === "todo" ? "text-muted" : "font-bold"}>{st.label}</span>
              {(st.href || st.tx) && (
                <a className="text-sm text-muted underline underline-offset-4" href={st.href ?? txUrl(st.tx!)} target="_blank" rel="noreferrer">Details</a>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <button type="button" className="btn btn-money btn-block" disabled={issues.length > 0 || !cfg.data} onClick={() => withSigner(create)}>
          {signer ? "Create the league" : "Sign in to create the league"}
        </button>
      )}
    </section>
  );
}

interface Step {
  label: string;
  state: "todo" | "active" | "done";
  tx?: string;
  href?: string;
}

const Check = () => (
  <span className="grid size-5 place-items-center rounded-full bg-money text-money-ink" aria-hidden>
    <svg width="11" height="11" viewBox="0 0 10 10"><path d="M1.5 5.2l2.2 2.2L8.5 2.6" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
  </span>
);

function Money({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label htmlFor={id} className="block">
      <span className="font-bold">{label}</span>
      <span className="relative mt-1 block w-40">
        <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted">$</span>
        <input id={id} className="field tnum pl-7" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} />
      </span>
    </label>
  );
}

function Invite({ leagueId, name }: { leagueId: number; name: string }) {
  const link = `${location.origin}/join/${leagueId}`;
  const text = `Dues for ${name} are on Commish. Pick your team and pay here: ${link}. The money sits in a league vault. Nobody, not even me, can take it.`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="pt-6">
      <h1 className="display text-[3rem] leading-none">Your league is live</h1>
      <p className="mt-2 text-lg">Send this link to the group chat. Everyone picks their team and pays there.</p>
      <div className="mt-5 flex gap-2">
        <input className="field mono" readOnly value={link} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn btn-ghost" onClick={() => navigator.clipboard?.writeText(link).then(() => setCopied(true))}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <button
        type="button"
        className="btn btn-money btn-block mt-3"
        onClick={() => (navigator.share ? navigator.share({ text }).catch(() => {}) : navigator.clipboard?.writeText(text).then(() => setCopied(true)))}
      >
        Share
      </button>
      <Link to={`/l/${leagueId}`} className="mt-6 inline-flex min-h-11 items-center font-bold underline underline-offset-4">Go to the league page</Link>
    </div>
  );
}
