import { Cache, HOUR } from "../cache.js";
import { fetchText, parseCsv, str } from "../csv.js";

const URL = "https://github.com/dynastyprocess/data/raw/master/files/db_playerids.csv";

/** Other sources' player IDs -> Sleeper player ID. */
export interface IdMaps {
  fantasypros: Record<string, string>;
  gsis: Record<string, string>;
  espn: Record<string, string>;
}

/** DynastyProcess's crosswalk of player IDs across fantasy sites. */
export function loadIdMaps(cache: Cache): Promise<IdMaps> {
  return cache.get("ids:crosswalk", 24 * HOUR, async () => {
    const maps: IdMaps = { fantasypros: {}, gsis: {}, espn: {} };
    for (const r of parseCsv(await fetchText(URL))) {
      const sleeper = str(r.sleeper_id);
      if (!sleeper) continue;
      const fp = str(r.fantasypros_id);
      const gsis = str(r.gsis_id);
      const espn = str(r.espn_id);
      if (fp) maps.fantasypros[fp] = sleeper;
      if (gsis) maps.gsis[gsis] = sleeper;
      if (espn) maps.espn[espn] = sleeper;
    }
    return maps;
  });
}

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

export function normName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .split(/\s+/)
    .filter((w) => w && !SUFFIXES.has(w))
    .join(" ");
}

/**
 * Fallback matcher for players missing from the ID crosswalk (often rookies and
 * kickers): exact normalized name + team, else a name that is unique league-wide.
 */
export class NameIndex {
  private byNameTeam = new Map<string, string>();
  private byName = new Map<string, string | null>();

  constructor(players: Record<string, { id: string; name: string; team: string | null }>) {
    for (const p of Object.values(players)) {
      const n = normName(p.name);
      if (p.team) this.byNameTeam.set(`${n}|${p.team}`, p.id);
      // null marks an ambiguous name (two players share it).
      this.byName.set(n, this.byName.has(n) ? null : p.id);
    }
  }

  find(name: string | undefined, team: string | undefined): string | undefined {
    if (!name) return undefined;
    const n = normName(name);
    const t = normTeam(team);
    return (t && this.byNameTeam.get(`${n}|${t}`)) || this.byName.get(n) || undefined;
  }
}

/** FantasyPros and ESPN use a few non-standard team codes; Sleeper's are the canonical ones here. */
const TEAM_ALIASES: Record<string, string> = { JAC: "JAX", WSH: "WAS", LA: "LAR", OAK: "LV", SD: "LAC", STL: "LAR" };

export function normTeam(team: string | undefined): string | undefined {
  if (!team) return undefined;
  const t = team.toUpperCase();
  return TEAM_ALIASES[t] ?? t;
}
