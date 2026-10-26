import { Cache, HOUR } from "../cache.js";
import { fetchText, num, parseCsv, str } from "../csv.js";
import { round1 } from "../scoring.js";
import { loadIdMaps, type NameIndex } from "./ids.js";

// ffopportunity (nflverse family): per-game actual vs expected fantasy points from play-by-play,
// plus player and team volume. Updated nightly in season.
const EP_URL = (season: string) =>
  `https://github.com/ffverse/ffopportunity/releases/download/latest-data/ep_weekly_${season}.csv`;

export interface UsageGame {
  week: number;
  fp: number;
  xfp: number;
  tgt: number;
  team_tgt: number;
  air: number;
  team_air: number;
  rush: number;
  team_rush: number;
}

export interface UsageSummary {
  games: number;
  /** PPR fantasy points per game. */
  fp_pg: number;
  /** Expected PPR points per game given volume and field position. */
  xfp_pg: number;
  /** fp - xfp per game: positive = scoring above what usage supports (often TD-driven, may regress). */
  over_expected_pg: number;
  target_share?: number;
  air_yards_share?: number;
  rush_share?: number;
}

export interface UsageData {
  through_week: number;
  games: Record<string, UsageGame[]>;
}

export function loadUsage(cache: Cache, names: NameIndex, season: string): Promise<UsageData> {
  return cache.get(`nflverse:ep:${season}`, 6 * HOUR, async () => {
    const [ids, csv] = await Promise.all([loadIdMaps(cache), fetchText(EP_URL(season))]);
    const games: Record<string, UsageGame[]> = {};
    let through = 0;
    for (const r of parseCsv(csv)) {
      const gsis = str(r.player_id);
      const id = (gsis && ids.gsis[gsis]) || names.find(r.full_name, r.posteam);
      const week = num(r.week);
      if (!id || week == null) continue;
      through = Math.max(through, week);
      (games[id] ??= []).push({
        week,
        fp: num(r.total_fantasy_points) ?? 0,
        xfp: num(r.total_fantasy_points_exp) ?? 0,
        tgt: num(r.rec_attempt) ?? 0,
        team_tgt: num(r.rec_attempt_team) ?? 0,
        air: num(r.rec_air_yards) ?? 0,
        team_air: num(r.rec_air_yards_team) ?? 0,
        rush: num(r.rush_attempt) ?? 0,
        team_rush: num(r.rush_attempt_team) ?? 0,
      });
    }
    for (const list of Object.values(games)) list.sort((a, b) => a.week - b.week);
    return { through_week: through, games };
  });
}

function pct(part: number, whole: number): number | undefined {
  return whole > 0 ? round1((100 * part) / whole) : undefined;
}

export function summarizeUsage(games: UsageGame[]): UsageSummary | undefined {
  if (!games.length) return undefined;
  const sum = (f: (g: UsageGame) => number) => games.reduce((s, g) => s + f(g), 0);
  const n = games.length;
  const fp = sum((g) => g.fp);
  const xfp = sum((g) => g.xfp);
  return {
    games: n,
    fp_pg: round1(fp / n),
    xfp_pg: round1(xfp / n),
    over_expected_pg: round1((fp - xfp) / n),
    target_share: pct(sum((g) => g.tgt), sum((g) => g.team_tgt)),
    air_yards_share: pct(sum((g) => g.air), sum((g) => g.team_air)),
    rush_share: pct(sum((g) => g.rush), sum((g) => g.team_rush)),
  };
}
