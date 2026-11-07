// Join (SPEC 5.3): pick your team, sign in, claim it, pay dues.
import { useState } from "react";
import { Link, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { claimant, dollars, isPending, type League, type Team, type TeamInfo } from "@commish/shared";
import { Avatar, ErrorNote, Spinner } from "../components/bits";
import { LeagueHeader } from "../components/LeagueHeader";
import * as act from "../lib/actions";
import { useAuth, useWithSigner, type Signer } from "../lib/auth";
import { txUrl } from "../lib/config";
import { teamName, useLeague, usePot, useSleeper, useTeams, useUsdc } from "../lib/queries";
import { worker } from "../lib/worker";

export function Join() {
  const id = Number(useParams().leagueId);
  const league = useLeague(Number.isInteger(id) ? id : null);
  const teams = useTeams(Number.isInteger(id) ? id : null);
  const sleeper = useSleeper(league.data?.sleeper_league_id);
  const pot = usePot(league.data?.vault, true);
  const { signer } = useAuth();
  const [picked, setPicked] = useState<number | null>(null);
  if (league.isLoading || teams.isLoading) return <Spinner label="Loading the league" />;
  if (!league.data || !teams.data) return <p className="py-8 text-muted">No league here. Check the invite link.</p>;
  const l = league.data;
  if (l.status !== "Active") return <Spinner label="The league's vault is still being created" />;
  const sTeams = sleeper.data?.teams;
  const mine = signer ? teams.data.find((t) => claimant(t) === signer.accountId) : undefined;
  const rosterId = mine?.roster_id ?? picked;
  const team = teams.data.find((t) => t.roster_id === rosterId);
  const paidCount = teams.data.filter((t) => BigInt(t.dues_paid) >= BigInt(l.dues)).length;

  return (
    <div>
      <LeagueHeader league={l} sleeper={sleeper.data?.league} teams={sTeams} commissionerTeam={teams.data.find((t) => t.account === l.commissioner)?.roster_id} />
      <p className="text-lg">
        Dues: <b className="display tnum text-2xl">{dollars(l.dues)}</b> · Pot so far: <b className="display tnum text-2xl">{pot.data === undefined ? "…" : dollars(pot.data)}</b> · {paidCount} of {teams.data.length} paid
      </p>

      {!mine && (
        <TeamPicker teams={teams.data} sTeams={sTeams} league={l} picked={picked} onPick={setPicked} />
      )}
      {team && <ClaimAndPay league={l} team={team} sTeams={sTeams} mine={!!mine} paidCount={paidCount} total={teams.data.length} />}
    </div>
  );
}

function TeamPicker({ teams, sTeams, league, picked, onPick }: { teams: Team[]; sTeams: TeamInfo[] | undefined; league: League; picked: number | null; onPick: (r: number) => void }) {
  return (
    <section aria-labelledby="pick-h" className="mt-8">
      <h2 id="pick-h" className="display text-3xl">Which team is yours?</h2>
      {teams.every((t) => t.claim !== "Unclaimed") && (
        <p className="mt-1 text-muted">Every team in this league is claimed. If one of them is yours, ask the commissioner.</p>
      )}
      <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {teams.map((t) => {
          const taken = t.claim !== "Unclaimed";
          const name = teamName(sTeams, t.roster_id);
          const avatar = sTeams?.find((x) => x.roster_id === t.roster_id)?.avatar;
          const selected = picked === t.roster_id;
          return (
            <li key={t.roster_id}>
              <button
                type="button"
                disabled={taken}
                aria-pressed={selected}
                onClick={() => onPick(t.roster_id)}
                className={`flex min-h-16 w-full items-center gap-2.5 rounded-2xl border-2 p-2.5 text-left transition-colors ${
                  selected ? "border-money bg-money-tint" : "border-line bg-surface hover:border-ink/40"
                } disabled:cursor-not-allowed disabled:opacity-45`}
              >
                <Avatar src={avatar} name={name} size={40} />
                <span className="min-w-0">
                  <span className="block truncate font-bold">{name}</span>
                  <span className="block text-xs text-muted">
                    {taken ? "Claimed" : BigInt(t.dues_paid) >= BigInt(league.dues) ? "Paid" : "Open"}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ClaimAndPay({ league, team, sTeams, mine, paidCount, total }: { league: League; team: Team; sTeams: TeamInfo[] | undefined; mine: boolean; paidCount: number; total: number }) {
  const { signer } = useAuth();
  const withSigner = useWithSigner();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const name = teamName(sTeams, team.roster_id);
  const owed = BigInt(league.dues) - BigInt(team.dues_paid);
  const paid = owed <= 0n;
  const refresh = () => {
    setTimeout(() => {
      qc.invalidateQueries({ queryKey: ["teams", league.id] });
      qc.invalidateQueries({ queryKey: ["league", league.id] });
      qc.invalidateQueries({ queryKey: ["pot", league.vault] });
    }, 1200);
  };

  const claim = (s: Signer) =>
    (async () => {
      setBusy(true);
      setError(null);
      try {
        await act.claim(s, league.id, team.roster_id);
        refresh();
      } catch (e) {
        setError(e);
      } finally {
        setBusy(false);
      }
    })();

  return (
    <section aria-labelledby="claim-h" className="mt-8 space-y-4">
      <h2 id="claim-h" className="display text-3xl">{mine ? name : `You picked ${name}`}</h2>
      {!mine && (
        <div className="space-y-2">
          <button type="button" className="btn btn-money btn-block" disabled={busy} onClick={() => withSigner(claim)}>
            {busy ? <Spinner label="Claiming" /> : signer ? `Claim ${name}` : "Sign in to claim it"}
          </button>
          <p className="text-sm text-muted">The commissioner confirms each team, so payouts reach the right person.</p>
        </div>
      )}
      {mine && isPending(team.claim) && (
        <p className="flex items-center gap-2 rounded-xl border-2 border-hold bg-hold-tint px-3 py-2 font-bold text-hold" role="status">
          <span className="spinner" aria-hidden /> Waiting for the commissioner to confirm your team. You can pay now; it counts either way.
        </p>
      )}
      {mine && team.claim === "Approved" && (
        <p className="rounded-xl border-2 border-money bg-money-tint px-3 py-2 font-bold text-money" role="status">The commissioner confirmed your team.</p>
      )}
      <ErrorNote error={error} />
      {mine && !paid && signer && <PayDues league={league} team={team} owed={owed} signer={signer} onPaid={refresh} />}
      {mine && paid && (
        <div className="rounded-2xl bg-board p-5 text-board-ink">
          <p className="display text-4xl text-lamp">You're in.</p>
          <p className="mt-1">{paidCount} of {total} paid.</p>
          <Link to={`/l/${league.id}`} className="btn btn-money mt-4">Go to the league</Link>
        </div>
      )}
    </section>
  );
}

const TOKENS = [
  { id: "nep141:sol.omft.near", label: "SOL" },
  { id: "nep141:eth.omft.near", label: "ETH" },
  { id: "nep141:btc.omft.near", label: "BTC" },
  { id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", label: "USDC on Base" },
];

function PayDues({ league, team, owed, signer, onPaid }: { league: League; team: Team; owed: bigint; signer: Signer; onPaid: () => void }) {
  const usdc = useUsdc(signer.accountId);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<"pay" | "faucet" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tx, setTx] = useState<string | null>(null);
  const [other, setOther] = useState(false);
  const short = usdc.data !== undefined && usdc.data < owed;
  return (
    <div className="space-y-3 rounded-2xl border-2 border-line bg-surface p-4">
      <h3 className="display text-2xl">Pay {dollars(owed)} dues</h3>
      <p className="text-sm text-muted">
        In USDC on NEAR (testnet: Test USDC). Your balance: <b className="tnum">{usdc.data === undefined ? "…" : dollars(usdc.data)}</b>
      </p>
      {short ? (
        <button
          type="button"
          className="btn btn-ghost btn-block"
          disabled={busy !== null}
          onClick={async () => {
            setBusy("faucet");
            setError(null);
            try {
              await worker.faucet(signer.accountId);
              setTimeout(() => qc.invalidateQueries({ queryKey: ["usdc", signer.accountId] }), 1500);
            } catch (e) {
              setError(e);
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === "faucet" ? <Spinner label="Minting" /> : "Get test USDC"}
        </button>
      ) : null}
      <button
        type="button"
        className="btn btn-money btn-block"
        disabled={busy !== null || short || usdc.data === undefined}
        onClick={async () => {
          setBusy("pay");
          setError(null);
          try {
            const r = await act.payDues(signer, league.id, team.roster_id, owed);
            setTx(r.txHash);
            onPaid();
            setTimeout(() => qc.invalidateQueries({ queryKey: ["usdc", signer.accountId] }), 1500);
          } catch (e) {
            setError(e);
          } finally {
            setBusy(null);
          }
        }}
      >
        {busy === "pay" ? <Spinner label="Paying" /> : `Pay ${dollars(owed)}`}
      </button>
      {tx && (
        <a href={txUrl(tx)} target="_blank" rel="noreferrer" className="block text-sm underline underline-offset-4">Payment sent</a>
      )}
      <ErrorNote error={error} />
      <button type="button" className="min-h-11 text-sm font-bold underline underline-offset-4" onClick={() => setOther((v) => !v)} aria-expanded={other}>
        Pay with another token or chain
      </button>
      {other && <IntentsPreview owed={owed} />}
    </div>
  );
}

function IntentsPreview({ owed }: { owed: bigint }) {
  const [token, setToken] = useState(TOKENS[0]!);
  const [state, setState] = useState<{ busy: boolean; text?: string; time?: number; error?: unknown }>({ busy: false });
  const load = async (t = token) => {
    setState({ busy: true });
    try {
      const { quote } = await worker.quote(t.id, owed.toString());
      setState({ busy: false, text: `${quote.amountInFormatted} ${t.label}`, time: quote.timeEstimate });
    } catch (error) {
      setState({ busy: false, error });
    }
  };
  return (
    <div className="space-y-3 rounded-xl border-2 border-dashed border-line p-3">
      <p className="text-sm font-bold text-hold">Preview: real mainnet quote, not executed in this demo.</p>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Pay with">
        {TOKENS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={t.id === token.id}
            className={`btn ${t.id === token.id ? "btn-ink" : "btn-ghost"}`}
            onClick={() => {
              setToken(t);
              load(t);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      {!state.text && !state.busy && !state.error && (
        <button type="button" className="btn btn-ghost" onClick={() => load()}>Get a quote</button>
      )}
      {state.busy && <Spinner label="Asking NEAR Intents" />}
      {state.text && (
        <p>
          You'd send <b className="tnum">≈{state.text}</b> to a one-time deposit address. Your league receives <b>{dollars(owed)} USDC</b>
          {state.time ? `, in about ${state.time} seconds` : ""}.
        </p>
      )}
      <ErrorNote error={state.error} />
    </div>
  );
}
