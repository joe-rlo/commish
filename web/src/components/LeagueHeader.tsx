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
    <div className="flex items-center gap-4 py-4">
      <Avatar src={avatarUrl(sleeper?.avatar)} name={league.name} size={64} />
      <div className="min-w-0">
        <h1 className="display text-[2.4rem] leading-none">{league.name}</h1>
        <p className="mt-1 text-muted">{league.season} season</p>
        <p className="mt-1 flex min-w-0 items-center gap-1.5 text-muted">
          <span className="rounded-md bg-board px-1.5 py-0.5 text-xs font-bold text-board-ink">Commissioner</span>
          <span className="truncate">{commissionerName ?? league.commissioner.split(".")[0]}</span>
        </p>
      </div>
    </div>
  );
}
