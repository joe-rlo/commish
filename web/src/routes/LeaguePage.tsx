// The league page (SPEC 5.4): pot, dues, payouts, next up, season, commissioner panel.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  claimant, dollars, holdWords, isPending, keyId, nsToMs, sameKey, splitWords, standings, weekFinality,
  type Key, type League, type Settlement, type Team, type TeamInfo,
} from "@commish/shared";
import { Avatar, Details, ErrorNote, Fact, Scoreboard, Spinner } from "../components/bits";
import { LeagueHeader } from "../components/LeagueHeader";
import { ordinal, SettlementStub, useNow } from "../components/Receipt";
import * as act from "../lib/actions";
import { useAuth, useWithSigner } from "../lib/auth";
import { accountUrl, txUrl } from "../lib/config";
import { rejectThreshold } from "../lib/near";
import { teamAvatar, teamName, useConfig, useLeague, useNflState, usePot, useSettlements, useSleeper, useTeams, useVaultMembers } from "../lib/queries";

export function LeaguePage({ leagueId, demo = false }: { leagueId: number; demo?: boolean }) {
  const league = useLeague(leagueId);
  const teams = useTeams(leagueId);
  const settlements = useSettlements(leagueId);
  const l = league.data;
  const sleeper = useSleeper(l?.sleeper_league_id);
  const onHold = settlements.data?.some((s) => s.status === "OnHold" || s.status === "Requested") ?? false;
  const pot = usePot(l?.vault, onHold);
  const { signer } = useAuth();

  if (league.isLoading) return <Spinner label="Loading the league" />;
  if (league.error) return <ErrorNote error={league.error} />;
  if (!l) return <NotFound />;
  if (l.status === "CreatingVault") return <Spinner label="Creating the league's vault" />;

  const sTeams = sleeper.data?.teams;
  const commissionerTeam = teams.data?.find((t) => t.account === l.commissioner)?.roster_id ?? null;
  const isCommissioner = signer?.accountId === l.commissioner;

  return (
    <div>
      {demo && (
        <p className="mt-2 rounded-xl border-2 border-hold bg-hold-tint px-3 py-2 text-sm font-bold text-hold">
          Demo league · NEAR testnet · Press Settle on any week to watch it pay out.
        </p>
      )}
      <LeagueHeader league={l} sleeper={sleeper.data?.league} teams={sTeams} commissionerTeam={commissionerTeam} />
      <PotCard league={l} pot={pot.data} />
      <Dues league={l} teams={teams.data} sTeams={sTeams} />
      <Payouts league={l} settlements={settlements.data} sTeams={sTeams} demo={demo} />
      <NextUp league={l} settlements={settlements.data} sleeperStatus={sleeper.data?.league.status} demo={demo} />
      <Season league={l} settlements={settlements.data} sTeams={sTeams} pot={pot.data} />
      {isCommissioner && <CommissionerPanel league={l} teams={teams.data} sTeams={sTeams} />}
    </div>
  );
}

function NotFound() {
  return (
    <div className="py-10">
      <h1 className="display text-4xl">No league here</h1>
      <p className="mt-2 text-muted">Check the link, or start one.</p>
      <Link to="/new" className="btn btn-money mt-4">Start a league</Link>
    </div>
  );
}

function PotCard({ league, pot }: { league: League; pot: bigint | undefined }) {
  return (
    <section aria-labelledby="pot-h" className="board p-5">
      <h2 id="pot-h" className="text-sm font-bold text-board-dim">The pot</h2>
      <div className="mt-1">
        {pot === undefined ? <span className="lamp-digits text-6xl">…</span> : <Scoreboard units={pot} label="The pot" />}
      </div>
      <p className="mt-3 text-board-ink">Held in your league's vault. Nobody can withdraw it alone.</p>
      <div className="mt-3 text-board-ink [&_.text-muted]:text-board-dim [&_.mono]:text-board-ink">
        <Details>
          <Fact label="Vault" value={league.vault ?? "—"} href={league.vault ? accountUrl(league.vault) : undefined} />
          <Fact label="Token" value={league.token} href={accountUrl(league.token)} />
          <p className="text-board-dim">
            The vault is a Sputnik DAO. Commish can only propose payouts the rules compute, and approves them only after a {holdWords(league.hold_window_ns)} hold.
            During the hold, a majority of the league's teams can stop any payout. The same majority can vote to do anything else with the vault. The commissioner alone can't move money.
          </p>
          {BigInt(league.on_hold_total) > 0n && <Fact label="On hold" value={dollars(league.on_hold_total)} />}
        </Details>
      </div>
    </section>
  );
}

function Dues({ league, teams, sTeams }: { league: League; teams: Team[] | undefined; sTeams: TeamInfo[] | undefined }) {
  if (!teams) return null;
  const paid = teams.filter((t) => BigInt(t.dues_paid) >= BigInt(league.dues));
  return (
    <section aria-labelledby="dues-h" className="mt-8">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="dues-h" className="display text-3xl">Dues</h2>
        <p className="text-muted">
          {paid.length} of {teams.length} paid · <span className="display tnum text-xl text-ink">{dollars(league.dues_total)}</span>
        </p>
      </div>
      {paid.length === 0 && <p className="mt-2 text-muted">Nobody has paid yet. Share the invite link to get started.</p>}
      <ul className="mt-3 flex flex-wrap gap-2" aria-label="Teams">
        {teams.map((t) => {
          const ok = BigInt(t.dues_paid) >= BigInt(league.dues);
          const name = teamName(sTeams, t.roster_id);
          return (
            <li key={t.roster_id} className="relative" title={`${name}: ${ok ? "paid" : "not paid"}`}>
              <Avatar src={teamAvatar(sTeams, t.roster_id)} name={name} size={44} dim={!ok} />
              {ok && (
                <span className="absolute -right-0.5 -bottom-0.5 grid size-5 place-items-center rounded-full border-2 border-paper bg-money text-money-ink" aria-hidden>
                  <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 5.2l2.2 2.2L8.5 2.6" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
                </span>
              )}
              <span className="sr-only">{name}: {ok ? "paid" : "not paid"}</span>
            </li>
          );
        })}
      </ul>
      <Link to={`/join/${league.id}`} className="mt-3 inline-flex min-h-11 items-center font-bold underline underline-offset-4">
        Pick your team and pay
      </Link>
    </section>
  );
}

function Payouts({ league, settlements, sTeams, demo }: { league: League; settlements: Settlement[] | undefined; sTeams: TeamInfo[] | undefined; demo: boolean }) {
  const { signer } = useAuth();
  const members = useVaultMembers(league.vault);
  const isMember = !!signer && !!members.data?.members.includes(signer.accountId);
  useAutoFinalize(league, settlements, demo);
  return (
    <section aria-labelledby="payouts-h" className="mt-8">
      <h2 id="payouts-h" className="display text-3xl">Payouts</h2>
      {!settlements ? (
        <Spinner />
      ) : settlements.length === 0 ? (
        <p className="mt-2 text-muted">No payouts yet. Week 1's high score settles after its scores are final. Your money's safer than your waiver claims.</p>
      ) : (
        <ul className="mt-3 space-y-4">
          {settlements.map((s) => (
            <li key={keyId(s.key)}>
              <SettlementStub s={s} leagueId={league.id} teams={sTeams} demo={demo} />
              {s.status === "OnHold" && (
                <HoldRow league={league} s={s} isMember={isMember} votesToStop={members.data ? rejectThreshold(members.data.members.length, members.data.quorum) : 0} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Once the hold window is over, anyone can release the payout. Signed-in viewers do it for the league. */
function useAutoFinalize(league: League, settlements: Settlement[] | undefined, demo: boolean) {
  const { signer } = useAuth();
  const qc = useQueryClient();
  const now = useNow();
  const tried = useRef(new Set<string>());
  useEffect(() => {
    if (!signer || !settlements) return;
    for (const s of settlements) {
      if (s.status !== "OnHold" || nsToMs(s.hold_ends_at_ns) + 1500 > now) continue;
      const id = keyId(s.key);
      if (tried.current.has(id)) continue;
      // Real leagues: only members release automatically; demo: any signed-in viewer.
      if (!demo && signer.accountId !== league.commissioner && !s.payouts.some((p) => p.account === signer.accountId)) continue;
      tried.current.add(id);
      act
        .finalize(signer, league.id, s.key)
        .catch(() => tried.current.delete(id))
        .finally(() => {
          setTimeout(() => qc.invalidateQueries({ queryKey: ["settlements", league.id] }), 1500);
          setTimeout(() => qc.invalidateQueries({ queryKey: ["pot", league.vault] }), 3000);
        });
    }
  }, [signer, settlements, now, demo, league, qc]);
}

function HoldRow({ league, s, isMember, votesToStop }: { league: League; s: Settlement; isMember: boolean; votesToStop: number }) {
  const { signer } = useAuth();
  const withSigner = useWithSigner();
  const qc = useQueryClient();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ended = nsToMs(s.hold_ends_at_ns) <= now;
  const holdable = s.payouts.filter((p) => p.status === "OnHold" && p.proposal_id !== null);
  if (ended) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-3 px-1">
        <button
          type="button"
          className="btn btn-money"
          disabled={busy}
          onClick={() =>
            withSigner(async (sg) => {
              setBusy(true);
              setError(null);
              try {
                await act.finalize(sg, league.id, s.key);
                setTimeout(() => qc.invalidateQueries({ queryKey: ["settlements", league.id] }), 1500);
              } catch (e) {
                setError(e);
              } finally {
                setBusy(false);
              }
            })
          }
        >
          {busy ? <Spinner label="Paying out" /> : "Pay it out"}
        </button>
        <span className="text-sm text-muted">The hold is over. Anyone can release it.</span>
        <ErrorNote error={error} />
      </div>
    );
  }
  if (!isMember || !signer || holdable.length === 0) {
    return votesToStop > 0 ? (
      <p className="mt-2 px-1 text-sm text-muted">League members can vote to hold this payout before the countdown ends. It takes {votesToStop} votes.</p>
    ) : null;
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3 px-1">
      <button
        type="button"
        className="btn btn-stop"
        disabled={busy}
        onClick={async () => {
          if (!confirm("Vote to hold this payout? If a majority of the league votes the same way before the countdown ends, the money stays in the pot.")) return;
          setBusy(true);
          setError(null);
          try {
            for (const p of holdable) await act.holdPayout(signer, league.vault!, p.proposal_id!);
            qc.invalidateQueries({ queryKey: ["proposal"] });
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Spinner label="Voting" /> : "Hold this payout"}
      </button>
      <span className="text-sm text-muted">It takes {votesToStop} votes to stop it.</span>
      <ErrorNote error={error} />
    </div>
  );
}

function settled(settlements: Settlement[] | undefined, key: Key): Settlement | undefined {
  return settlements?.find((s) => sameKey(s.key, key) && s.status !== "Failed");
}

function NextUp({ league, settlements, sleeperStatus, demo }: { league: League; settlements: Settlement[] | undefined; sleeperStatus: string | undefined; demo: boolean }) {
  const nfl = useNflState();
  const now = useNow(30_000);
  if (!settlements || BigInt(league.weekly_amount) === 0n) return null;
  const weeks = Array.from({ length: league.regular_season_weeks }, (_, i) => i + 1);
  const open = weeks.filter((w) => !settled(settlements, { Week: w }));
  if (open.length === 0) return null;
  const finality = (w: number) => weekFinality(sleeperStatus ?? "", league.season, w, nfl.data ?? null, now);
  const shown = demo ? open : open.slice(0, 1);
  return (
    <section aria-labelledby="next-h" className="mt-8">
      <h2 id="next-h" className="display text-3xl">Next up</h2>
      {!demo && (
        <p className="mt-1 text-muted">Week {open[0]} settles once its scores are final. Anyone in the league can press the button.</p>
      )}
      <ul className={demo ? "mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3" : "mt-3"}>
        {shown.map((w) => (
          <li key={w}>
            <SettleButton league={league} k={{ Week: w }} label={`Settle week ${w}`} finality={finality(w)} compact={demo} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function SettleButton({ league, k, label, finality, compact }: { league: League; k: Key; label: string; finality: ReturnType<typeof weekFinality>; compact?: boolean }) {
  const withSigner = useWithSigner();
  const cfg = useConfig();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [tx, setTx] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <button
        type="button"
        className={`btn ${compact ? "btn-ghost w-full" : "btn-money"}`}
        disabled={!finality.final || busy || !cfg.data}
        title={finality.final ? undefined : finality.reason}
        onClick={() =>
          withSigner(async (sg) => {
            setBusy(true);
            setError(null);
            try {
              const r = await act.settle(sg, cfg.data!, league.id, k);
              setTx(r.txHash);
              qc.invalidateQueries({ queryKey: ["settlements", league.id] });
              qc.invalidateQueries({ queryKey: ["league", league.id] });
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          })
        }
      >
        {busy ? <Spinner label="Asking the enclave" /> : label}
      </button>
      {!finality.final && !compact && <p className="text-sm text-muted">{finality.reason}</p>}
      {tx && !compact && (
        <a className="text-sm underline underline-offset-4" href={txUrl(tx)} target="_blank" rel="noreferrer">
          Request sent
        </a>
      )}
      <ErrorNote error={error} />
    </div>
  );
}

function Season({ league, settlements, sTeams, pot }: { league: League; settlements: Settlement[] | undefined; sTeams: TeamInfo[] | undefined; pot: bigint | undefined }) {
  const sleeperStatus = useSleeper(league.sleeper_league_id).data?.league.status;
  const real = settled(settlements, "Season");
  const weekly = BigInt(league.weekly_amount);
  const unsettledWeeks = Array.from({ length: league.regular_season_weeks }, (_, i) => i + 1).filter((w) => !settled(settlements, { Week: w })).length;
  const projectedBase = useMemo(() => {
    if (pot === undefined) return null;
    const reserve = weekly * BigInt(unsettledWeeks) + BigInt(league.on_hold_total);
    return pot > reserve ? pot - reserve : 0n;
  }, [pot, weekly, unsettledWeeks, league.on_hold_total]);
  const order = sTeams ? standings(sTeams) : [];
  const canSettle = sleeperStatus === "complete" && (weekly === 0n || unsettledWeeks === 0) && !real;
  return (
    <section aria-labelledby="season-h" className="mt-8">
      <h2 id="season-h" className="display text-3xl">Season payout</h2>
      <p className="mt-1 text-muted">Split {splitWords(league.season_split_bps)} at season's end, from the playoff bracket.</p>
      {real ? (
        <p className="mt-2">
          <Link className="font-bold underline underline-offset-4" to={`/l/${league.id}/r/season`}>See the season receipt</Link>
        </p>
      ) : (
        <>
          <ul className="mt-3 divide-y divide-line">
            {league.season_split_bps.map((bps, i) => {
              const t = order[i];
              return (
                <li key={i} className="flex items-center gap-3 py-2.5">
                  <span className="display w-10 text-xl text-muted">{ordinal(i + 1)}</span>
                  {t ? <Avatar src={t.avatar} name={t.name} size={36} /> : null}
                  <span className="min-w-0 flex-1 truncate">{t?.name ?? "—"}</span>
                  <span className="display tnum text-2xl">{projectedBase === null ? "…" : dollars((projectedBase * BigInt(bps)) / 10_000n)}</span>
                </li>
              );
            })}
          </ul>
          <p className="mt-1 text-sm text-muted">Projected from current standings and what's left after weekly prizes.</p>
          {canSettle && (
            <div className="mt-3">
              <SettleButton league={league} k="Season" label="Settle the season" finality={{ final: true }} />
            </div>
          )}
          {sleeperStatus === "complete" && weekly > 0n && unsettledWeeks > 0 && (
            <p className="mt-2 text-sm text-muted">The season pays out after every week has settled ({unsettledWeeks} to go).</p>
          )}
        </>
      )}
    </section>
  );
}

function CommissionerPanel({ league, teams, sTeams }: { league: League; teams: Team[] | undefined; sTeams: TeamInfo[] | undefined }) {
  const { signer } = useAuth();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const pending = (teams ?? []).filter((t) => isPending(t.claim));
  const link = `${location.origin}/join/${league.id}`;
  const run = async (rid: number, f: () => Promise<unknown>) => {
    setBusy(rid);
    setError(null);
    try {
      await f();
      setTimeout(() => qc.invalidateQueries({ queryKey: ["teams", league.id] }), 1200);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-labelledby="comm-h" className="mt-10 border-t-4 border-ink pt-5">
      <h2 id="comm-h" className="display text-3xl">Commissioner</h2>
      <p className="mt-1 text-muted">Only you see this. Approving a team decides who gets its payouts. You can't move money from here.</p>
      <h3 className="mt-4 font-bold">Team claims</h3>
      {pending.length === 0 ? (
        <p className="text-muted">No claims waiting.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {pending.map((t) => (
            <li key={t.roster_id} className="flex flex-wrap items-center gap-3 py-3">
              <Avatar src={teamAvatar(sTeams, t.roster_id)} name={teamName(sTeams, t.roster_id)} size={40} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold">{teamName(sTeams, t.roster_id)}</p>
                <p className="mono truncate text-muted">{claimant(t)}</p>
              </div>
              <button type="button" className="btn btn-money" disabled={busy !== null} onClick={() => run(t.roster_id, () => act.approve(signer!, league.id, t.roster_id, claimant(t)!))}>
                {busy === t.roster_id ? <Spinner /> : "Approve"}
              </button>
              <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => run(t.roster_id, () => act.decline(signer!, league.id, t.roster_id))}>
                Decline
              </button>
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={error} />
      <h3 className="mt-5 font-bold">Invite link</h3>
      <div className="mt-2 flex gap-2">
        <input className="field mono" readOnly value={link} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn btn-ghost" onClick={() => navigator.clipboard?.writeText(link)}>Copy</button>
      </div>
    </section>
  );
}
