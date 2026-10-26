import { Cache, HOUR, MINUTE } from "./cache.js";

const API = "https://api.sleeper.app/v1";
// Undocumented but widely used endpoints (projections, stats, schedule).
const API_ROOT = "https://api.sleeper.app";

export const SKILL_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;
export const IDP_POSITIONS = ["DL", "LB", "DB"] as const;

export type Stats = Record<string, number>;

export interface NflState {
  week: number;
  display_week: number;
  season: string;
  season_type: string;
}

export interface SleeperUser {
  user_id: string;
  username: string;
  display_name: string;
}

export interface LeagueUser {
  user_id: string;
  display_name: string;
  metadata?: { team_name?: string };
}

export interface League {
  league_id: string;
  name: string;
  season: string;
  status: string;
  total_rosters: number;
  roster_positions: string[];
  scoring_settings: Record<string, number>;
  settings: Record<string, number>;
}

export interface Roster {
  roster_id: number;
  owner_id: string | null;
  co_owners?: string[] | null;
  players: string[] | null;
  starters: string[] | null;
  reserve: string[] | null;
  taxi: string[] | null;
  settings: Record<string, number>;
}

export interface Matchup {
  roster_id: number;
  matchup_id: number | null;
  points: number;
  starters: string[];
}

export interface Transaction {
  type: string;
  status: string;
  created: number;
  leg: number;
  roster_ids: number[];
  adds: Record<string, number> | null;
  drops: Record<string, number> | null;
  settings?: { waiver_bid?: number } | null;
}

export interface TrendingPlayer {
  player_id: string;
  count: number;
}

export interface Player {
  id: string;
  name: string;
  position: string;
  fantasy_positions: string[];
  team: string | null;
  age?: number;
  years_exp?: number;
  status?: string;
  injury_status?: string | null;
  injury_body_part?: string | null;
  injury_notes?: string | null;
  depth_chart_position?: string | null;
  depth_chart_order?: number | null;
  search_rank?: number | null;
  espn_id?: string | null;
  yahoo_id?: string | null;
}

export interface Projection {
  player_id: string;
  opponent: string | null;
  stats: Stats;
  injury_status: string | null;
}

export interface ScheduleGame {
  week: number;
  home: string;
  away: string;
  date: string;
  status: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Sleeper request failed (${res.status}): ${url}`);
  return (await res.json()) as T;
}

function positionsQuery(positions: readonly string[]): string {
  return positions.map((p) => `position[]=${p}`).join("&");
}

// Projections/stats carry ADP and other noise we never use; drop it to keep caches small.
function slimStats(stats: Stats | undefined): Stats {
  const out: Stats = {};
  for (const [k, v] of Object.entries(stats ?? {})) {
    if (typeof v === "number" && !k.startsWith("adp_") && !k.startsWith("pos_adp")) out[k] = v;
  }
  return out;
}

export class SleeperClient {
  constructor(private cache: Cache) {}

  state(): Promise<NflState> {
    return this.cache.get("sleeper:state", 15 * MINUTE, () => getJson(`${API}/state/nfl`));
  }

  user(usernameOrId: string): Promise<SleeperUser | null> {
    return this.cache.get(`sleeper:user:${usernameOrId.toLowerCase()}`, 24 * HOUR, () =>
      getJson(`${API}/user/${encodeURIComponent(usernameOrId)}`),
    );
  }

  userLeagues(userId: string, season: string): Promise<League[]> {
    return this.cache.get(`sleeper:leagues:${userId}:${season}`, HOUR, () =>
      getJson(`${API}/user/${userId}/leagues/nfl/${season}`),
    );
  }

  league(leagueId: string): Promise<League> {
    return this.cache.get(`sleeper:league:${leagueId}`, HOUR, () =>
      getJson(`${API}/league/${leagueId}`),
    );
  }

  // Rosters change with every waiver/trade, so keep this short.
  rosters(leagueId: string): Promise<Roster[]> {
    return this.cache.get(`sleeper:rosters:${leagueId}`, 2 * MINUTE, () =>
      getJson(`${API}/league/${leagueId}/rosters`),
    );
  }

  leagueUsers(leagueId: string): Promise<LeagueUser[]> {
    return this.cache.get(`sleeper:users:${leagueId}`, HOUR, () =>
      getJson(`${API}/league/${leagueId}/users`),
    );
  }

  matchups(leagueId: string, week: number): Promise<Matchup[]> {
    return this.cache.get(`sleeper:matchups:${leagueId}:${week}`, 5 * MINUTE, () =>
      getJson(`${API}/league/${leagueId}/matchups/${week}`),
    );
  }

  transactions(leagueId: string, week: number): Promise<Transaction[]> {
    return this.cache.get(`sleeper:tx:${leagueId}:${week}`, 5 * MINUTE, () =>
      getJson(`${API}/league/${leagueId}/transactions/${week}`),
    );
  }

  trending(type: "add" | "drop", lookbackHours = 24, limit = 50): Promise<TrendingPlayer[]> {
    return this.cache.get(`sleeper:trending:${type}:${lookbackHours}:${limit}`, 30 * MINUTE, () =>
      getJson(`${API}/players/nfl/trending/${type}?lookback_hours=${lookbackHours}&limit=${limit}`),
    );
  }

  /** The full player DB is ~5MB; Sleeper asks that it be fetched at most daily. */
  players(): Promise<Record<string, Player>> {
    return this.cache.get("sleeper:players", 24 * HOUR, async () => {
      const raw = await getJson<Record<string, any>>(`${API}/players/nfl`);
      const out: Record<string, Player> = {};
      for (const [id, p] of Object.entries(raw)) {
        if (!p.fantasy_positions?.length) continue;
        out[id] = {
          id,
          name: p.position === "DEF" ? `${p.first_name} ${p.last_name}`.trim() : p.full_name ?? `${p.first_name} ${p.last_name}`,
          position: p.position,
          fantasy_positions: p.fantasy_positions,
          team: p.team ?? null,
          age: p.age ?? undefined,
          years_exp: p.years_exp ?? undefined,
          status: p.status ?? undefined,
          injury_status: p.injury_status ?? null,
          injury_body_part: p.injury_body_part ?? null,
          injury_notes: p.injury_notes ?? null,
          depth_chart_position: p.depth_chart_position ?? null,
          depth_chart_order: p.depth_chart_order ?? null,
          search_rank: p.search_rank ?? null,
          espn_id: p.espn_id != null ? String(p.espn_id) : null,
          yahoo_id: p.yahoo_id != null ? String(p.yahoo_id) : null,
        };
      }
      return out;
    });
  }

  /** Weekly projections (Rotowire, via Sleeper), keyed by player_id. */
  projections(season: string, week: number, positions: readonly string[] = SKILL_POSITIONS): Promise<Record<string, Projection>> {
    const key = `sleeper:proj:${season}:${week}:${positions.join(",")}`;
    return this.cache.get(key, HOUR, async () => {
      const rows = await getJson<any[]>(
        `${API_ROOT}/projections/nfl/${season}/${week}?season_type=regular&${positionsQuery(positions)}`,
      );
      const out: Record<string, Projection> = {};
      for (const r of rows) {
        out[r.player_id] = {
          player_id: r.player_id,
          opponent: r.opponent ?? null,
          stats: slimStats(r.stats),
          injury_status: r.player?.injury_status ?? null,
        };
      }
      return out;
    });
  }

  /**
   * Actual stats for one week (`week`) or season-to-date totals (`week` omitted).
   * Pass `live` for a week with games in progress so stats refresh quickly.
   */
  stats(
    season: string,
    week?: number,
    positions: readonly string[] = SKILL_POSITIONS,
    live = false,
  ): Promise<Record<string, Stats>> {
    const path = week ? `${season}/${week}` : season;
    const ttl = live ? 10 * MINUTE : week ? 6 * HOUR : HOUR;
    return this.cache.get(`sleeper:stats:${path}:${positions.join(",")}`, ttl, async () => {
      const rows = await getJson<any[]>(
        `${API_ROOT}/stats/nfl/${path}?season_type=regular&${positionsQuery(positions)}`,
      );
      const out: Record<string, Stats> = {};
      for (const r of rows) out[r.player_id] = slimStats(r.stats);
      return out;
    });
  }

  schedule(season: string): Promise<ScheduleGame[]> {
    return this.cache.get(`sleeper:schedule:${season}`, 12 * HOUR, () =>
      getJson(`${API_ROOT}/schedule/nfl/regular/${season}`),
    );
  }
}
