import type { Cache } from "../cache.js";
import type { Player } from "../sleeper.js";
import { NameIndex } from "./ids.js";
import { loadEspn, type EspnData } from "./espn.js";
import { loadFantasyPros, type FpData } from "./fantasypros.js";
import { loadUsage, type UsageData } from "./nflverse.js";

export interface ExternalData {
  fp?: FpData;
  /** Which NFL week FantasyPros' weekly rankings are for (they roll over midweek). */
  fpWeek?: number;
  espn?: EspnData;
  usage?: UsageData;
  errors: Record<string, string>;
}

async function attempt<T>(name: string, errors: Record<string, string>, load: () => Promise<T>): Promise<T | undefined> {
  try {
    return await load();
  } catch (err) {
    errors[name] = err instanceof Error ? err.message : String(err);
    return undefined;
  }
}

/** Week whose matchups best match the rankings' listed opponents. */
function detectWeek(fp: FpData, opponents: Map<string, string>, around: number): number | undefined {
  let best: { week: number; hits: number } | undefined;
  for (const week of [around - 1, around, around + 1]) {
    let hits = 0;
    for (const r of Object.values(fp.weekly)) {
      if (r.team && r.opp && opponents.get(`${week}:${r.team}`)?.endsWith(r.opp)) hits++;
    }
    if (hits && (!best || hits > best.hits)) best = { week, hits };
  }
  return best?.week;
}

/** Third-party data, each source isolated so one outage doesn't break a tool call. */
export async function loadExternal(
  cache: Cache,
  players: Record<string, Player>,
  season: string,
  week: number,
  opponents: Map<string, string>,
): Promise<ExternalData> {
  const errors: Record<string, string> = {};
  const names = new NameIndex(players);
  const [fp, espn, usage] = await Promise.all([
    attempt("fantasypros", errors, () => loadFantasyPros(cache, names)),
    attempt("espn", errors, () => loadEspn(cache, names, season, week)),
    attempt("nflverse", errors, () => loadUsage(cache, names, season)),
  ]);
  return { fp, fpWeek: fp ? detectWeek(fp, opponents, week) : undefined, espn, usage, errors };
}
