import { Cache, HOUR } from "../cache.js";
import { round1 } from "../scoring.js";
import { loadIdMaps, type NameIndex } from "./ids.js";

// ESPN's public (unofficial) fantasy API. No key needed for league-default player data.
const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";

// ESPN proTeamId -> Sleeper team code (for team defenses).
const ESPN_TEAMS: Record<number, string> = {
  1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET", 9: "GB", 10: "TEN",
  11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ",
  21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WAS", 29: "CAR", 30: "JAX",
  33: "BAL", 34: "HOU",
};

export interface EspnPlayer {
  /** Average of ESPN analysts' positional PPR ranks for `rank_week`. */
  analyst_rank_avg?: number;
  analyst_rank_range?: string;
  analysts?: number;
  rank_week?: number;
  rostered_pct?: number;
  rostered_change?: number;
  started_pct?: number;
  outlook?: string;
  outlook_week?: number;
}

export interface EspnData {
  week: number;
  players: Record<string, EspnPlayer>;
}

export function loadEspn(cache: Cache, names: NameIndex, season: string, week: number): Promise<EspnData> {
  return cache.get(`espn:players:${season}:${week}`, 3 * HOUR, async () => {
    const ids = await loadIdMaps(cache);
    const filter = {
      players: {
        limit: 1500,
        sortPercOwned: { sortPriority: 1, sortAsc: false },
        filterRanksForScoringPeriodIds: { value: [week - 1, week].filter((w) => w >= 1) },
        filterRanksForRankTypes: { value: ["PPR"] },
        // Keeps the payload small (~3MB instead of ~20MB of stat history).
        filterStatsForTopScoringPeriodIds: { value: 1, additionalValue: [`10${season}`] },
      },
    };
    const res = await fetch(`${BASE}/${season}/segments/0/leaguedefaults/3?scoringPeriodId=${week}&view=kona_player_info`, {
      headers: { "X-Fantasy-Filter": JSON.stringify(filter), accept: "application/json" },
    });
    if (!res.ok) throw new Error(`ESPN request failed (${res.status})`);
    const body = (await res.json()) as { players: { player: any }[] };

    const players: Record<string, EspnPlayer> = {};
    for (const { player: p } of body.players) {
      const sleeperId =
        p.defaultPositionId === 16
          ? ESPN_TEAMS[p.proTeamId]
          : ids.espn[String(p.id)] ?? names.find(p.fullName, ESPN_TEAMS[p.proTeamId]);
      if (!sleeperId) continue;

      const out: EspnPlayer = {
        rostered_pct: p.ownership?.percentOwned != null ? round1(p.ownership.percentOwned) : undefined,
        rostered_change: p.ownership?.percentChange != null ? round1(p.ownership.percentChange) : undefined,
        started_pct: p.ownership?.percentStarted != null ? round1(p.ownership.percentStarted) : undefined,
      };

      // Latest week with published analyst ranks (ESPN publishes the next week's midweek).
      const rankWeeks = Object.keys(p.rankings ?? {}).map(Number).filter((w) => w > 0).sort((a, b) => b - a);
      const rw = rankWeeks.find((w) => w <= week);
      if (rw != null) {
        const ranks = (p.rankings[String(rw)] as any[])
          .filter((r) => r.rankType === "PPR" && r.rank > 0)
          .map((r) => r.rank as number);
        if (ranks.length) {
          out.analyst_rank_avg = round1(ranks.reduce((s, r) => s + r, 0) / ranks.length);
          out.analyst_rank_range = `${Math.min(...ranks)}-${Math.max(...ranks)}`;
          out.analysts = ranks.length;
          out.rank_week = rw;
        }
      }

      const outlooks = p.outlooks?.outlooksByWeek ?? {};
      const ow = Object.keys(outlooks).map(Number).filter((w) => w <= week).sort((a, b) => b - a)[0];
      if (ow != null) {
        out.outlook = String(outlooks[String(ow)]);
        out.outlook_week = ow;
      }
      players[sleeperId] = out;
    }
    return { week, players };
  });
}
