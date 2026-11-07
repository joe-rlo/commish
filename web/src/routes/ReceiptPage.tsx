// A receipt (SPEC 5.5): the scoreboard it came from, the payouts, the proof, and "Check the math".
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { checkMath, dollars, keyTitle, parseKeyId, points, sleeperFetch, type CheckResult, type Settlement, type TeamInfo } from "@commish/shared";
import { Avatar, Details, ErrorNote, Fact, Spinner, Stamp } from "../components/bits";
import { failureWords, ordinal, payoutStamp, useNow } from "../components/Receipt";
import { accountUrl, attestationAppUrl, attestationUrl, config, txUrl } from "../lib/config";
import { commish } from "../lib/near";
import { loadCore, teamAvatar, teamName, useConfig, useLeague, useSleeper } from "../lib/queries";

interface Attestation {
  request_id: number;
  transaction_hash: string;
  executed_wasm_sha256: string;
  input_hash: string;
  output_hash: string;
  worker_measurement: string;
  timestamp: number;
}

export function ReceiptPage() {
  const params = useParams();
  const [sp] = useSearchParams();
  const leagueId = Number(params.leagueId);
  const key = parseKeyId(params.settlementId ?? "");
  const league = useLeague(Number.isInteger(leagueId) ? leagueId : null);
  const sleeper = useSleeper(league.data?.sleeper_league_id);
  const s = useQuery({
    queryKey: ["settlement", leagueId, params.settlementId],
    queryFn: () => commish.settlement(leagueId, key!),
    enabled: !!key && Number.isInteger(leagueId),
    refetchInterval: (q) => {
      const st = (q.state.data as Settlement | null | undefined)?.status;
      return st === "Requested" || st === "Computed" ? 3000 : st === "OnHold" ? 5000 : false;
    },
  });
  const now = useNow();
  if (!key) return <p>That isn't a receipt link.</p>;
  if (s.isLoading || league.isLoading) return <Spinner label="Loading the receipt" />;
  if (!s.data || !league.data) return <p className="py-8 text-muted">No receipt here yet.</p>;
  const st = s.data;
  const teams = sleeper.data?.teams;
  const back = sp.get("demo") ? "/demo" : `/l/${leagueId}`;
  const winners = new Set(st.payouts.map((p) => p.roster_id));
  const top = st.scores[0]?.points_x100;
  const tied = st.scores.filter((x) => !x.missing && x.points_x100 === top).length > 1;
  const shareText =
    st.key === "Season"
      ? `Season payout for ${league.data.name}: ${st.payouts.map((p) => `${teamName(teams, p.roster_id)} ${dollars(p.amount)}`).join(", ")}. Paid automatically by Commish. Receipt: ${location.href}`
      : `${keyTitle(st.key)}: ${st.payouts.map((p) => teamName(teams, p.roster_id)).join(" & ") || teamName(teams, st.scores[0]?.roster_id ?? 0)}, ${top !== undefined ? points(top) : ""}. ${st.payouts[0] ? `${dollars(st.payouts[0].amount)} paid automatically by Commish.` : ""} Receipt: ${location.href}`;

  return (
    <article className="pt-4">
      <Link to={back} className="inline-flex min-h-11 items-center text-muted underline-offset-4 hover:underline">
        {league.data.name}
      </Link>
      <h1 className="display text-[2.8rem] leading-none">{keyTitle(st.key)}</h1>
      <p className="mt-1 text-muted">{league.data.season} season</p>

      {(st.status === "Requested" || st.status === "Computed") && (
        <p className="mt-6">
          <Spinner label="The enclave is reading Sleeper and checking the math." />
        </p>
      )}
      {st.status === "Failed" && <p className="mt-6 text-muted">{failureWords(st.error)}</p>}

      {st.payouts.length > 0 && (
        <section aria-labelledby="pay-h" className="stub mt-6 p-4 pb-2" style={{ ["--perf" as string]: "calc(100% - 3.2rem)" }}>
          <h2 id="pay-h" className="sr-only">Payouts</h2>
          <ul>
            {st.payouts.map((p, i) => {
              const stamp = payoutStamp(p, st, now);
              return (
                <li key={i} className={`py-3 ${i > 0 ? "border-t border-line" : ""}`}>
                  <div className="flex items-center gap-3">
                    <Avatar src={teamAvatar(teams, p.roster_id)} name={teamName(teams, p.roster_id)} size={48} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-bold">{p.place ? `${ordinal(p.place)} · ` : ""}{teamName(teams, p.roster_id)}</p>
                      <p className="mono truncate text-muted">{p.account ?? "no approved account"}</p>
                    </div>
                    <span className="display tnum text-3xl">{dollars(p.amount)}</span>
                  </div>
                  {stamp.note && <p className="mt-1 text-sm text-muted">{stamp.note}</p>}
                </li>
              );
            })}
          </ul>
          <div className="perf -mx-4 mt-2 flex items-center justify-between gap-2 px-4 py-3">
            <span className="text-sm text-muted">{tied ? "Tied. The prize was split evenly; rounding dust stays in the pot." : "From the league's vault."}</span>
            {[...new Map(st.payouts.map((p) => [payoutStamp(p, st, now).label, payoutStamp(p, st, now)])).values()].map((x) => (
              <Stamp key={x.label} kind={x.kind}>{x.label}</Stamp>
            ))}
          </div>
        </section>
      )}

      {st.scores.length > 0 && (
        <section aria-labelledby="board-h" className="mt-8">
          <h2 id="board-h" className="display text-3xl">The scoreboard</h2>
          <ol className="mt-2 divide-y divide-line">
            {st.scores.map((x, i) => (
              <li key={x.roster_id} className={`flex items-center gap-3 py-2.5 ${winners.has(x.roster_id) ? "font-bold" : ""}`}>
                <span className="tnum w-6 text-right text-muted">{i + 1}</span>
                <Avatar src={teamAvatar(teams, x.roster_id)} name={teamName(teams, x.roster_id)} size={32} />
                <span className="min-w-0 flex-1 truncate">{teamName(teams, x.roster_id)}</span>
                {winners.has(x.roster_id) && <span className="rounded-md bg-money-tint px-1.5 py-0.5 text-xs font-bold text-money">High score</span>}
                <span className="display tnum text-xl">{x.missing ? "No lineup" : points(x.points_x100)}</span>
              </li>
            ))}
          </ol>
          {tied && <p className="mt-2 text-sm text-muted">Tie at the top: the weekly prize is split evenly.</p>}
        </section>
      )}

      {st.placements.length > 0 && (
        <section className="mt-8">
          <h2 className="display text-3xl">Final standings</h2>
          <ol className="mt-2 divide-y divide-line">
            {st.placements.map((p) => (
              <li key={p.place} className="flex items-center gap-3 py-2.5">
                <span className="display w-10 text-xl">{ordinal(p.place)}</span>
                <Avatar src={teamAvatar(teams, p.roster_id)} name={teamName(teams, p.roster_id)} size={32} />
                <span className="truncate">{teamName(teams, p.roster_id)}</span>
              </li>
            ))}
          </ol>
          {st.payout_base && <p className="mt-2 text-sm text-muted">Split of {dollars(st.payout_base)}, the pot when the season settled.</p>}
        </section>
      )}

      {st.result_sha256 && <CheckTheMath s={st} leagueId={leagueId} teams={teams} />}
      {st.result_sha256 && <Proof s={st} />}

      <div className="mt-8 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => (navigator.share ? navigator.share({ text: shareText }).catch(() => {}) : navigator.clipboard?.writeText(shareText))}
        >
          Share
        </button>
      </div>
    </article>
  );
}

function CheckTheMath({ s, leagueId, teams }: { s: Settlement; leagueId: number; teams: TeamInfo[] | undefined }) {
  const [state, setState] = useState<{ busy: boolean; result?: CheckResult; error?: unknown }>({ busy: false });
  return (
    <section aria-labelledby="check-h" className="mt-8 rounded-2xl border-2 border-line p-4">
      <h2 id="check-h" className="display text-3xl">Check the math</h2>
      <p className="mt-1 text-muted">
        Runs the same payout code in your browser, on live Sleeper data, and compares it with this receipt.
      </p>
      <button
        type="button"
        className="btn btn-ink mt-3"
        disabled={state.busy}
        onClick={async () => {
          setState({ busy: true });
          try {
            const core = await loadCore();
            const input = await commish.jobInput(leagueId, s.key, s.requested_at_ns);
            const result = await checkMath(core, s, input, sleeperFetch);
            setState({ busy: false, result });
          } catch (error) {
            setState({ busy: false, error });
          }
        }}
      >
        {state.busy ? <Spinner label="Checking" /> : state.result ? "Check again" : "Check the math"}
      </button>
      <div aria-live="polite" className="mt-3">
        <ErrorNote error={state.error} />
        {state.result && (state.result.matches ? (
          <p className="display text-4xl text-money">Matches ✓</p>
        ) : (
          <div>
            <p className="display text-3xl text-stop">{state.result.diffs.length ? "It changed" : "Same math, different data"}</p>
            {state.result.diffs.length > 0 ? (
              <ul className="mt-2 list-disc pl-5 text-sm">
                {state.result.diffs.map((d) => <li key={d}>{renameTeams(d, teams)}</li>)}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-muted">The payouts are the same, but Sleeper's raw data changed since this settled (for example a stat correction to a bench player).</p>
            )}
          </div>
        ))}
        {state.result && (
          <div className="mt-3 text-sm">
            <Details summary="What was checked">
              <Fact label="Input" value={state.result.inputOk ? "same request the contract sent ✓" : "differs ✗"} />
              <Fact label="Result" value={state.result.resultOk ? "same bytes as the enclave's ✓" : "differs ✗"} />
              <Fact label="Sleeper data" value={state.result.sourceOk ? "unchanged ✓" : "changed since"} />
              <Fact label="Recomputed" value={state.result.recomputedSha256} />
            </Details>
          </div>
        )}
      </div>
    </section>
  );
}

function renameTeams(d: string, teams: TeamInfo[] | undefined): string {
  return d.replace(/Team (\d+)/g, (_, r) => teamName(teams, Number(r)));
}

function Proof({ s }: { s: Settlement }) {
  const cfg = useConfig();
  const att = useQuery({
    queryKey: ["attestation", s.attestation_ref],
    queryFn: async () => {
      const r = await fetch(attestationUrl(s.attestation_ref!));
      if (!r.ok) throw new Error(`OutLayer answered ${r.status}`);
      return (await r.json()) as Attestation;
    },
    enabled: !!s.attestation_ref,
    staleTime: Infinity,
    retry: 3,
  });
  const a = att.data;
  const ok = (x: boolean) => (x ? " ✓" : " ✗");
  return (
    <section aria-labelledby="proof-h" className="mt-8">
      <h2 id="proof-h" className="display text-3xl">Proof</h2>
      <div className="mt-3 space-y-5">
        <div className="space-y-2">
          <h3 className="font-bold">Computed in a verified enclave</h3>
          <p className="text-sm text-muted">OutLayer ran the pinned Commish build inside an Intel TDX enclave and signed what it saw and what it returned.</p>
          {s.attestation_ref && (
            <>
              <Fact label="Code" value={`${a?.executed_wasm_sha256 ?? cfg.data?.job_wasm_sha256 ?? "…"}${a && cfg.data ? ok(a.executed_wasm_sha256 === cfg.data.job_wasm_sha256) : ""}`} />
              <Fact label="Input" value={`${s.input_sha256}${a ? ok(a.input_hash === s.input_sha256) : ""}`} />
              <Fact label="Output" value={`${s.result_sha256}${a ? ok(a.output_hash === s.result_sha256) : ""}`} />
              <Fact label="Attestation" value={`OutLayer request ${s.attestation_ref}`} href={attestationAppUrl(s.attestation_ref)} />
              <Fact label="Raw record" value="JSON with the TDX quote" href={attestationUrl(s.attestation_ref)} />
              {a && <Fact label="Request tx" value={a.transaction_hash} href={txUrl(a.transaction_hash)} />}
            </>
          )}
          {att.error ? <p className="text-sm text-muted">Couldn't load the attestation from OutLayer right now.</p> : null}
        </div>
        <div className="space-y-2">
          <h3 className="font-bold">Source</h3>
          <p className="text-sm text-muted">The exact Sleeper API URLs used, and the SHA-256 of their data (RFC 8785 canonical JSON).</p>
          {s.source_urls.map((u) => (
            <Fact key={u} label="URL" value={u.replace("https://api.sleeper.app/v1/", "…/")} href={u} />
          ))}
          <Fact label="SHA-256" value={s.source_sha256 ?? "—"} />
        </div>
        <div className="space-y-2">
          <h3 className="font-bold">Vault payout</h3>
          {s.payouts.filter((p) => p.proposal_id !== null).map((p) => (
            <Fact key={p.proposal_id} label={`Proposal ${p.proposal_id}`} value={`${dollars(p.amount)} to ${p.account}, ${p.status === "Paid" ? "approved by the vault" : p.status.toLowerCase()}`} href={p.account ? accountUrl(p.account) : undefined} />
          ))}
          {s.payouts.every((p) => p.proposal_id === null) && <p className="text-sm text-muted">Nothing was sent from the vault for this one.</p>}
          <Fact label="Contract" value={config.contractId} href={accountUrl(config.contractId)} />
        </div>
      </div>
    </section>
  );
}
