import type { Cache } from "./cache.js";
import { optimalLineup, leaguePositions, round1, scorePoints, startingSlots } from "./scoring.js";
import type { League, LeagueUser, Player, Projection, Roster, ScheduleGame, SleeperClient, Stats } from "./sleeper.js";
import { loadExternal, type ExternalData } from "./sources/index.js";
import type { FpRank } from "./sources/fantasypros.js";
import { summarizeUsage, type UsageSummary } from "./sources/nflverse.js";

export interface PlayerRow {
  id: string;
  name: string;
  pos: string;
  team: string | null;
  injury: string | null;
  bye: number | null;
  opp: string | null;
  proj: number;
  ros: number;
  ros_games: number;
  playoffs: number;
  season: { gp: number; pts: number; ppg: number };
  /** Points in the player's last 3 played team games, keyed "wk7" (null = team played, he didn't). */
  last3: Record<string, number | null>;
  depth_chart?: string;
  age?: number;
  /** FantasyPros weekly consensus (for fp_week.week). */
  fp_week?: FpRank & { week?: number; grade?: string };
  /** FantasyPros rest-of-season consensus. */
  fp_ros?: FpRank & { overall?: number };
  espn?: {
    analyst_rank_avg?: number;
    analyst_rank_range?: string;
    analysts?: number;
    rank_week?: number;
    rostered_pct?: number;
    rostered_change?: number;
    started_pct?: number;
  };
  usage?: { season?: UsageSummary; last3?: UsageSummary };
}

/** Everything about one league needed to answer roster questions, fetched once per call. */
export interface LeagueContext {
  league: League;
  season: string;
  week: number;
  lastWeek: number;
  playoffStart: number;
  positions: string[];
  rosters: Roster[];
  users: Map<string, LeagueUser>;
  players: Record<string, Player>;
  rosteredBy: Map<string, number>;
  byes: Map<string, number>;
  opponents: Map<string, string>;
  gameStatus: Map<string, string>;
  weeklyProj: Map<number, Record<string, Projection>>;
  seasonStats: Record<string, Stats>;
  /** Most recent first; includes the current week once any of its games has kicked off. */
  recentStats: { week: number; stats: Record<string, Stats> }[];
  /** Whether any game in `week` has kicked off (so current-week stats exist). */
  weekStarted: boolean;
  ext: ExternalData;
}

/** A team's game in `week` has kicked off (final or in progress). */
export function gameStarted(ctx: LeagueContext, team: string | null | undefined, week: number): boolean {
  if (!team) return false;
  const status = ctx.gameStatus.get(`${week}:${team}`);
  return status === "complete" || status === "in_game";
}

/** Last week of the fantasy season, derived from the league's playoff settings. */
function fantasyLastWeek(league: League): number {
  const s = league.settings;
  const start = s.playoff_week_start || 15;
  const rounds = Math.max(1, Math.ceil(Math.log2(Math.max(2, s.playoff_teams || 6))));
  // playoff_round_type: 0 = one week per round, 1 = two-week final, 2 = two weeks per round
  const extra = s.playoff_round_type === 2 ? rounds : s.playoff_round_type === 1 ? 1 : 0;
  return Math.min(18, start + rounds - 1 + extra);
}

function scheduleMaps(games: ScheduleGame[]) {
  const playing = new Map<number, Set<string>>();
  const opponents = new Map<string, string>();
  const gameStatus = new Map<string, string>();
  for (const g of games) {
    if (!playing.has(g.week)) playing.set(g.week, new Set());
    playing.get(g.week)!.add(g.home).add(g.away);
    opponents.set(`${g.week}:${g.home}`, `vs ${g.away}`);
    opponents.set(`${g.week}:${g.away}`, `@${g.home}`);
    gameStatus.set(`${g.week}:${g.home}`, g.status);
    gameStatus.set(`${g.week}:${g.away}`, g.status);
  }
  const teams = new Set(games.flatMap((g) => [g.home, g.away]));
  const byes = new Map<string, number>();
  for (const [week, set] of playing) {
    for (const t of teams) if (!set.has(t)) byes.set(t, week);
  }
  return { byes, opponents, gameStatus };
}

/**
 * Sleeper's state.week only advances midweek. Once every game of that week is
 * final, roster decisions are about the next week.
 */
function decisionWeek(stateWeek: number, games: ScheduleGame[]): number {
  const thisWeek = games.filter((g) => g.week === stateWeek);
  return thisWeek.length && thisWeek.every((g) => g.status === "complete") ? stateWeek + 1 : stateWeek;
}

export function rosterPlayerIds(r: Roster): string[] {
  return [...new Set([...(r.players ?? []), ...(r.reserve ?? []), ...(r.taxi ?? [])])];
}

export function teamName(r: Roster, users: Map<string, LeagueUser>): string {
  const u = r.owner_id ? users.get(r.owner_id) : undefined;
  return u?.metadata?.team_name || u?.display_name || `Team ${r.roster_id}`;
}

export class Analyzer {
  constructor(
    public sleeper: SleeperClient,
    private cache: Cache,
  ) {}

  async context(leagueId: string, weekOverride?: number): Promise<LeagueContext> {
    const [league, rosters, usersList, state, players] = await Promise.all([
      this.sleeper.league(leagueId),
      this.sleeper.rosters(leagueId),
      this.sleeper.leagueUsers(leagueId),
      this.sleeper.state(),
      this.sleeper.players(),
    ]);
    const season = league.season || state.season;
    const schedule = await this.sleeper.schedule(season);
    const week = weekOverride ?? decisionWeek(Math.max(1, state.week), schedule);
    const lastWeek = fantasyLastWeek(league);
    const positions = leaguePositions(league.roster_positions);

    const weeks: number[] = [];
    for (let w = week; w <= lastWeek; w++) weeks.push(w);
    const weekStarted = schedule.some((g) => g.week === week && g.status !== "pre_game");
    const weekLive = schedule.some((g) => g.week === week && g.status === "in_game");
    // Four weeks back covers "last 3 games" for players with a bye in that window.
    const recentWeeks = [weekStarted ? week : null, week - 1, week - 2, week - 3, week - 4].filter(
      (w): w is number => w != null && w >= 1,
    );

    const [projList, seasonStats, recentList] = await Promise.all([
      Promise.all(weeks.map((w) => this.sleeper.projections(season, w, positions))),
      this.sleeper.stats(season, undefined, positions),
      Promise.all(recentWeeks.map((w) => this.sleeper.stats(season, w, positions, w === week && weekLive))),
    ]);

    const { byes, opponents, gameStatus } = scheduleMaps(schedule);
    const ext = await loadExternal(this.cache, players, season, week, opponents);
    const rosteredBy = new Map<string, number>();
    for (const r of rosters) for (const id of rosterPlayerIds(r)) rosteredBy.set(id, r.roster_id);

    return {
      league,
      season,
      week,
      lastWeek,
      playoffStart: league.settings.playoff_week_start || 15,
      positions,
      rosters,
      users: new Map(usersList.map((u) => [u.user_id, u])),
      players,
      rosteredBy,
      byes,
      opponents,
      gameStatus,
      weeklyProj: new Map(weeks.map((w, i) => [w, projList[i]])),
      seasonStats,
      recentStats: recentWeeks.map((w, i) => ({ week: w, stats: recentList[i] })),
      weekStarted,
      ext,
    };
  }

  /** Find the roster a Sleeper username owns or co-owns in this league. */
  async findRoster(ctx: LeagueContext, username: string): Promise<Roster> {
    const user = await this.sleeper.user(username);
    if (!user) throw new Error(`Sleeper user "${username}" not found`);
    const roster = ctx.rosters.find(
      (r) => r.owner_id === user.user_id || r.co_owners?.includes(user.user_id),
    );
    if (!roster) throw new Error(`"${username}" has no team in league ${ctx.league.name}`);
    return roster;
  }

  row(ctx: LeagueContext, id: string): PlayerRow {
    const p = ctx.players[id];
    const scoring = ctx.league.scoring_settings;
    const team = p?.team ?? null;
    const thisWeek = ctx.weeklyProj.get(ctx.week)?.[id];

    let ros = 0;
    let rosGames = 0;
    let playoffs = 0;
    for (const [w, proj] of ctx.weeklyProj) {
      const pr = proj[id];
      if (!pr) continue;
      const pts = scorePoints(pr.stats, scoring);
      ros += pts;
      if (pts > 0) rosGames++;
      if (w >= ctx.playoffStart) playoffs += pts;
    }

    const st = ctx.seasonStats[id];
    const gp = st?.gp ?? 0;
    const seasonPts = scorePoints(st, scoring);

    return {
      id,
      name: p?.name ?? id,
      pos: p?.position ?? "?",
      team,
      injury: thisWeek?.injury_status ?? p?.injury_status ?? null,
      bye: team ? ctx.byes.get(team) ?? null : null,
      opp: team ? this.opponent(ctx, team, ctx.week) : null,
      proj: round1(scorePoints(thisWeek?.stats, scoring)),
      ros: round1(ros),
      ros_games: rosGames,
      playoffs: round1(playoffs),
      season: { gp, pts: round1(seasonPts), ppg: gp ? round1(seasonPts / gp) : 0 },
      last3: this.lastGames(ctx, id, team, 3),
      depth_chart:
        p?.depth_chart_position && p.depth_chart_order ? `${p.depth_chart_position}${p.depth_chart_order}` : undefined,
      age: p?.age,
      ...this.external(ctx, id),
    };
  }

  /** League-scored points in the player's team's last `n` games that have kicked off (skips byes). */
  lastGames(ctx: LeagueContext, id: string, team: string | null, n: number): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const { week, stats } of ctx.recentStats) {
      if (Object.keys(out).length >= n) break;
      if (team && !gameStarted(ctx, team, week)) continue;
      const live = ctx.gameStatus.get(`${week}:${team}`) === "in_game";
      out[`wk${week}${live ? " (live)" : ""}`] = stats[id] ? round1(scorePoints(stats[id], ctx.league.scoring_settings)) : null;
    }
    return out;
  }

  /** FantasyPros / ESPN / usage fields for a player; omitted when a source has nothing. */
  external(ctx: LeagueContext, id: string): Pick<PlayerRow, "fp_week" | "fp_ros" | "espn" | "usage"> {
    const { fp, fpWeek, espn, usage } = ctx.ext;
    const out: Pick<PlayerRow, "fp_week" | "fp_ros" | "espn" | "usage"> = {};

    const w = fp?.weekly[id];
    if (w) out.fp_week = { week: fpWeek, rank: w.rank, ecr: w.ecr, sd: w.sd, best: w.best, worst: w.worst, grade: w.grade };
    const r = fp?.ros[id];
    if (r) out.fp_ros = r;

    const e = espn?.players[id];
    if (e) {
      const { outlook, outlook_week, ...rest } = e;
      out.espn = rest;
    }

    const games = usage?.games[id];
    if (games?.length) out.usage = { season: summarizeUsage(games), last3: summarizeUsage(games.slice(-3)) };
    return out;
  }

  /** "vs GB", "@MIN (final)", "BYE"; flags games already played/underway since those players are locked. */
  opponent(ctx: LeagueContext, team: string, week: number): string | null {
    const opp = ctx.opponents.get(`${week}:${team}`);
    if (!opp) return ctx.byes.get(team) === week ? "BYE" : null;
    const status = ctx.gameStatus.get(`${week}:${team}`);
    return status === "complete" ? `${opp} (final)` : status === "in_game" ? `${opp} (in progress)` : opp;
  }

  /** Projected-best lineup for a roster in the context's week. */
  lineup(ctx: LeagueContext, roster: Roster) {
    const ids = roster.players ?? [];
    const reserve = new Set(roster.reserve ?? []);
    const candidates = ids
      .filter((id) => !reserve.has(id))
      .map((id) => {
        const row = this.row(ctx, id);
        return {
          id,
          positions: ctx.players[id]?.fantasy_positions ?? [row.pos],
          points: row.proj,
          unavailable: row.opp === "BYE" || row.injury === "Out" || row.injury === "IR",
        };
      });
    return optimalLineup(startingSlots(ctx.league.roster_positions), candidates);
  }

  /** Every player not on any roster at a position this league uses. */
  freeAgentIds(ctx: LeagueContext): string[] {
    return Object.values(ctx.players)
      .filter(
        (p) =>
          !ctx.rosteredBy.has(p.id) &&
          p.team &&
          p.fantasy_positions.some((pos) => ctx.positions.includes(pos)),
      )
      .map((p) => p.id);
  }

  findPlayers(ctx: LeagueContext, query: string): Player[] {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    const q = norm(query);
    const all = Object.values(ctx.players);
    const exact = all.filter((p) => norm(p.name) === q || p.id === query);
    const matches = exact.length ? exact : all.filter((p) => norm(p.name).includes(q));
    return matches
      .sort((a, b) => Number(!!b.team) - Number(!!a.team) || (a.search_rank ?? 1e9) - (b.search_rank ?? 1e9))
      .slice(0, 5);
  }
}
