import { Cache, HOUR } from "../cache.js";
import { fetchText, num, parseCsv, str } from "../csv.js";
import { loadIdMaps, normTeam, type NameIndex } from "./ids.js";

// FantasyPros consensus rankings, scraped ~twice daily by DynastyProcess. Skill positions are PPR pages.
const WEEKLY_URL = "https://github.com/dynastyprocess/data/raw/master/files/fp_latest_weekly.csv";
const ECR_URL = "https://github.com/dynastyprocess/data/raw/master/files/db_fpecr_latest.csv";

export interface FpRank {
  rank: string;
  ecr: number;
  sd?: number;
  best?: number;
  worst?: number;
}

export interface FpWeekly extends FpRank {
  grade?: string;
  rostered_pct?: number;
  team?: string;
  opp?: string;
}

export interface FpData {
  scraped: string | undefined;
  weekly: Record<string, FpWeekly>;
  ros: Record<string, FpRank & { overall?: number }>;
}

export function loadFantasyPros(cache: Cache, names: NameIndex): Promise<FpData> {
  return cache.get("fp:rankings", 3 * HOUR, async () => {
    const [ids, weeklyCsv, ecrCsv] = await Promise.all([loadIdMaps(cache), fetchText(WEEKLY_URL), fetchText(ECR_URL)]);
    const data: FpData = { scraped: undefined, weekly: {}, ros: {} };

    const sleeperId = (fpId: string | undefined, name: string | undefined, pos: string | undefined, team: string | undefined) => {
      // Team defenses are keyed by team code in Sleeper.
      if (pos === "DST") return normTeam(team);
      return (fpId && ids.fantasypros[fpId]) || names.find(name, team);
    };

    for (const r of parseCsv(weeklyCsv)) {
      const id = sleeperId(r.fantasypros_id, r.player_name, r.pos, r.team);
      const ecr = num(r.ecr);
      if (!id || ecr == null) continue;
      data.scraped ??= str(r.scrape_date);
      data.weekly[id] = {
        rank: str(r.pos_rank) ?? `${r.pos}${r.rank}`,
        ecr,
        sd: num(r.sd),
        best: num(r.best),
        worst: num(r.worst),
        grade: str(r.start_sit_grade),
        rostered_pct: num(r.player_owned_avg),
        team: normTeam(str(r.team)),
        opp: normTeam(str(r.player_opponent_id)),
      };
    }

    // Rest-of-season pages: ros-qb, ros-ppr-rb/wr/te, ros-k, ros-dst, ros-dl/lb/db, plus the overall page.
    const rosRows = parseCsv(ecrCsv).filter((r) => r.fp_page?.includes("/ros-"));
    const byPage = new Map<string, Record<string, string>[]>();
    for (const r of rosRows) {
      if (!byPage.has(r.fp_page)) byPage.set(r.fp_page, []);
      byPage.get(r.fp_page)!.push(r);
    }
    for (const [page, rows] of byPage) {
      rows.sort((a, b) => (num(a.ecr) ?? 999) - (num(b.ecr) ?? 999));
      // Combined pages (overall, all-IDP) only contribute the overall rank below.
      if (page.includes("overall") || page.endsWith("ros-idp.php")) continue;
      rows.forEach((r, i) => {
        const id = sleeperId(r.id, r.player, r.pos, r.team || r.tm);
        const ecr = num(r.ecr);
        if (!id || ecr == null) return;
        data.ros[id] = { rank: `${r.pos}${i + 1}`, ecr, sd: num(r.sd), best: num(r.best), worst: num(r.worst) };
      });
    }
    const overallPage = [...byPage.entries()].find(([p]) => p.includes("ros-ppr-overall"))?.[1] ?? [];
    overallPage.forEach((r, i) => {
      const id = sleeperId(r.id, r.player, r.pos, r.team || r.tm);
      if (id && data.ros[id]) data.ros[id].overall = i + 1;
    });

    return data;
  });
}
