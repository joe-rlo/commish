import { avatarUrl, type League, type SleeperLeague, type TeamInfo } from "@commish/shared";
import { Avatar } from "./bits";

/** League avatar, name, season and the commissioner. */
export function LeagueHeader({ league, sleeper, teams, commissionerTeam }: {
  league: League;
  sleeper: SleeperLeague | undefined;
  teams: TeamInfo[] | undefined;
  commissionerTeam?: number | null;
}) {
  const commissionerName =
    commissionerTeam != null ? teams?.find((t) => t.roster_id === commissionerTeam)?.name : null;
  return (
    <div className="endzone mt-3 flex items-center gap-4">
      <span className="shrink-0 rounded-full ring-4 ring-[var(--chalk)]">
        <Avatar src={avatarUrl(sleeper?.avatar)} name={league.name} size={64} />
      </span>
      <div className="min-w-0">
        <h1 className="painted text-[clamp(1.8rem,8vw,2.6rem)] leading-[1.04]">{league.name}</h1>
        <p className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-bold">{league.season} season</span>
          <span className="rounded-md bg-[var(--paint-edge)] px-1.5 py-0.5 text-xs font-bold">Commissioner</span>
          <span className="truncate">{commissionerName ?? league.commissioner.split(".")[0]}</span>
        </p>
      </div>
    </div>
  );
}
