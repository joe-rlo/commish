// Receipt stubs: one per settlement in the payouts feed.
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { countdown, dollars, keyId, keyTitle, nsToMs, points, type Payout, type Settlement, type TeamInfo } from "@commish/shared";
import { Avatar, Spinner, Stamp, type StampKind } from "./bits";
import { teamAvatar, teamName } from "../lib/queries";

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

const WITHHELD: Record<string, string> = {
  no_account: "no approved account",
  dues_unpaid: "dues unpaid",
  pot_too_small: "pot too small",
};

/** What a payout's stamp says right now. */
export function payoutStamp(p: Payout, s: Settlement, now: number): { kind: StampKind; label: string; note?: string } {
  switch (p.status) {
    case "Paid":
      return { kind: "paid", label: "Paid" };
    case "Stopped":
      return { kind: "stop", label: "Stopped", note: "Stopped by the league. The money stays in the pot." };
    case "Withheld":
      return { kind: "muted", label: "Withheld", note: `Withheld: ${WITHHELD[p.withheld_reason ?? ""] ?? "by the rules"}. The money stays in the pot.` };
    case "Failed":
      return { kind: "muted", label: "Not sent", note: "The payout couldn't be set up. The money stays in the pot." };
    case "Pending":
      return { kind: "hold", label: "Setting up" };
    case "OnHold": {
      const left = nsToMs(s.hold_ends_at_ns) - now;
      return left > 0 ? { kind: "hold", label: `On hold ${countdown(left)}` } : { kind: "hold", label: "Ready to pay" };
    }
  }
}

/** Plain words for an enclave or contract error. */
export function failureWords(error: string | null): string {
  if (!error) return "It didn't settle. Try again.";
  if (error.startsWith("WEEK_NOT_FINAL")) return "Scores aren't final yet. Try again after the week's stat corrections.";
  if (error.startsWith("SEASON_NOT_COMPLETE")) return "The season isn't over on Sleeper yet.";
  if (error.startsWith("BRACKET_INCOMPLETE")) return "The playoff bracket isn't finished on Sleeper yet.";
  if (error.startsWith("SLEEPER_UNREACHABLE")) return "Sleeper didn't answer the enclave. Try again in a minute.";
  if (error.includes("failed or timed out")) return "The enclave didn't answer in time. Try again.";
  return error.replace(/^[A-Z_]+: /, "");
}

export function SettlementStub({ s, leagueId, teams, demo }: { s: Settlement; leagueId: number; teams: TeamInfo[] | undefined; demo?: boolean }) {
  const now = useNow();
  const href = `/l/${leagueId}/r/${keyId(s.key)}${demo ? "?demo=1" : ""}`;
  const working = s.status === "Requested" || s.status === "Computed";
  const score = (rid: number) => s.scores.find((x) => x.roster_id === rid);
  return (
    <Link to={href} className="stub block p-4 pb-0 text-ink no-underline transition-colors hover:border-ink/40" aria-label={`${keyTitle(s.key)} receipt`}>
        <div className="flex items-start justify-between gap-3">
          <h3 className="display text-2xl">{keyTitle(s.key)}</h3>
          {working && <Stamp kind="hold">Working</Stamp>}
          {s.status === "Failed" && <Stamp kind="muted">Not settled</Stamp>}
          {s.status === "Final" && s.payouts.length === 0 && <Stamp kind="muted">No payout</Stamp>}
        </div>
        {working && (
          <p className="mt-3 pb-4">
            <Spinner label="The enclave is reading Sleeper and checking the math." />
          </p>
        )}
        {s.status === "Failed" && <p className="mt-2 pb-4 text-muted">{failureWords(s.error)}</p>}
        {!working && s.status !== "Failed" && s.payouts.length === 0 && s.scores[0] && (
          <p className="mt-2 pb-4 text-muted">
            Top score: {teamName(teams, s.scores[0].roster_id)}, {points(s.scores[0].points_x100)}. This league pays no weekly prize.
          </p>
        )}
        {s.payouts.length > 0 && (
          <ul className="mt-3">
            {s.payouts.map((p, i) => {
              const st = payoutStamp(p, s, now);
              const sc = score(p.roster_id);
              return (
                <li key={`${p.roster_id}-${i}`} className={`flex items-center gap-3 py-3 ${i > 0 ? "border-t border-line" : ""}`}>
                  <Avatar src={teamAvatar(teams, p.roster_id)} name={teamName(teams, p.roster_id)} size={44} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-bold">
                      {p.place ? `${ordinal(p.place)} · ` : ""}
                      {teamName(teams, p.roster_id)}
                    </p>
                    <p className="text-sm text-muted"><span className="display tnum text-base">{sc ? points(sc.points_x100) : ""}</span>{sc ? " pts" : p.place ? "Season finish" : ""}</p>
                  </div>
                  <span className="display tnum text-[1.7rem]">{dollars(p.amount)}</span>
                </li>
              );
            })}
          </ul>
        )}
        {s.payouts.length > 0 && (
          <div className="perf -mx-4 mt-1 flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <span className="text-sm text-muted">{summaryLine(s, now)}</span>
            <span className="flex flex-wrap gap-2">
              {dedupe(s.payouts.map((p) => payoutStamp(p, s, now))).map((st) => (
                <Stamp key={st.label} kind={st.kind}>
                  {st.label}
                </Stamp>
              ))}
            </span>
          </div>
        )}
      </Link>
  );
}

function dedupe<T extends { label: string }>(xs: T[]): T[] {
  return xs.filter((x, i) => xs.findIndex((y) => y.label === x.label) === i);
}

function summaryLine(s: Settlement, now: number): string {
  if (s.payouts.some((p) => p.status === "OnHold")) {
    return nsToMs(s.hold_ends_at_ns) > now ? "The league can stop this payout until the hold ends." : "Hold window over. Pays when anyone opens it.";
  }
  const notes = s.payouts.map((p) => payoutStamp(p, s, now).note).filter(Boolean);
  if (notes.length) return notes[0]!;
  return s.payouts.length > 1 ? "Tied. The prize was split evenly." : "Paid automatically from the pot.";
}

export function ordinal(n: number): string {
  return n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
}
