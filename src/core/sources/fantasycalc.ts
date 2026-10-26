import { Cache, HOUR } from "../cache.js";
import type { League } from "../sleeper.js";

// FantasyCalc trade values, derived from real trades. Public, no key needed.
const BASE = "https://api.fantasycalc.com/values/current";

export interface TradeValue {
  value: number;
  rank: number;
  pos_rank: number;
  /** Change in value over the last 30 days. */
  trend_30d: number;
  tier?: number;
  trade_frequency?: number;
}

export interface FantasyCalcData {
  /** Query params used, for data_as_of. */
  params: string;
  players: Record<string, TradeValue>;
}

function pprParam(rec: number | undefined): number {
  const r = rec ?? 0;
  return r >= 0.75 ? 1 : r >= 0.25 ? 0.5 : 0;
}

export function loadFantasyCalc(cache: Cache, league: League): Promise<FantasyCalcData> {
  const dynasty = league.settings.type === 2;
  const qbs = league.roster_positions.includes("SUPER_FLEX") ? 2 : 1;
  const params = `isDynasty=${dynasty}&numQbs=${qbs}&numTeams=${league.total_rosters}&ppr=${pprParam(league.scoring_settings.rec)}`;
  return cache.get(`fantasycalc:${params}`, 6 * HOUR, async () => {
    const res = await fetch(`${BASE}?${params}`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`FantasyCalc request failed (${res.status})`);
    const body = (await res.json()) as any[];
    const players: Record<string, TradeValue> = {};
    for (const p of body) {
      const id = p.player?.sleeperId;
      if (!id) continue;
      players[String(id)] = {
        value: p.value,
        rank: p.overallRank,
        pos_rank: p.positionRank,
        trend_30d: p.trend30Day,
        tier: p.maybeTier ?? undefined,
        trade_frequency: p.maybeTradeFrequency ?? undefined,
      };
    }
    return { params, players };
  });
}
