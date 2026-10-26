import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Cache } from "./cache.js";
import { Analyzer, gameStarted, rosterPlayerIds, teamName, type LeagueContext, type PlayerRow } from "./league.js";
import { Research, depthAhead, newsSummary } from "./research.js";
import { SLOT_ELIGIBILITY, round1, scorePoints, startingSlots } from "./scoring.js";
import type { Roster, SleeperClient } from "./sleeper.js";
import { loadNews } from "./sources/news.js";
import { evaluateTrade, positionalDepth } from "./trades.js";

const WAIVER_TYPES: Record<number, string> = { 0: "rolling", 1: "reverse_standings", 2: "FAAB" };

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function asOf(ctx: LeagueContext) {
  const { fp, fpWeek, espn, usage, trade, errors } = ctx.ext;
  const ppr = ctx.league.scoring_settings.rec ?? 0;
  return {
    fetched_at: new Date().toISOString(),
    season: ctx.season,
    week: ctx.week,
    sources: {
      projections: "Rotowire via Sleeper, scored with this league's scoring settings",
      fantasypros: fp
        ? `consensus (ECR) scraped ${fp.scraped}; weekly ranks are for week ${fpWeek ?? "?"}${ppr < 1 ? "; skill-position ranks are PPR, this league is not" : ""}`
        : "unavailable",
      espn: espn ? "analyst ranks (avg of ESPN analysts, PPR positional), rostered %, outlooks" : "unavailable",
      usage: usage
        ? `nflverse play-by-play through week ${usage.through_week}${usage.through_week === ctx.week ? " (partial: only games final at its last nightly update)" : ""}; xfp/fp are PPR`
        : "unavailable",
      trade_values: trade
        ? `FantasyCalc redraft trade values (from real trades), ${trade.params}; players not listed are below the trade-market floor`
        : "unavailable",
      stats: ctx.weekStarted
        ? `Sleeper box scores include week ${ctx.week} games that have kicked off (10-min refresh while live)`
        : `Sleeper box scores through week ${ctx.week - 1}`,
      injuries: "Sleeper injury designations, refreshed hourly; lag beat reporters and in-game injuries, so search news for anything time-sensitive",
      news: "ESPN player news blurbs, refreshed every 30 min",
      ...(Object.keys(errors).length ? { errors } : {}),
    },
  };
}

function record(r: Roster) {
  const s = r.settings;
  return {
    wins: s.wins ?? 0,
    losses: s.losses ?? 0,
    ties: s.ties ?? 0,
    points_for: round1((s.fpts ?? 0) + (s.fpts_decimal ?? 0) / 100),
  };
}

function standings(ctx: LeagueContext): Map<number, number> {
  const sorted = [...ctx.rosters].sort((a, b) => {
    const ra = record(a);
    const rb = record(b);
    return rb.wins - ra.wins || rb.points_for - ra.points_for;
  });
  return new Map(sorted.map((r, i) => [r.roster_id, i + 1]));
}

function scoringSummary(scoring: Record<string, number>) {
  const keys = ["rec", "bonus_rec_te", "bonus_rec_rb", "bonus_rec_wr", "pass_td", "pass_int", "pass_yd", "rush_td", "rec_td", "fum_lost"];
  return Object.fromEntries(keys.filter((k) => scoring[k] != null).map((k) => [k, scoring[k]]));
}

function waiverInfo(ctx: LeagueContext, roster?: Roster) {
  const s = ctx.league.settings;
  const type = WAIVER_TYPES[s.waiver_type] ?? String(s.waiver_type);
  return {
    type,
    ...(type === "FAAB"
      ? { budget: s.waiver_budget, remaining: roster ? s.waiver_budget - (roster.settings.waiver_budget_used ?? 0) : undefined }
      : { position: roster?.settings.waiver_position }),
    clear_days: s.waiver_clear_days,
  };
}

/** Players dropped recently enough that they're on waivers rather than free agents. */
async function onWaivers(sleeper: SleeperClient, ctx: LeagueContext): Promise<Set<string>> {
  const clearMs = (ctx.league.settings.waiver_clear_days ?? 2) * 86_400_000;
  const weeks = [ctx.week, ctx.week - 1].filter((w) => w >= 1);
  const txs = (await Promise.all(weeks.map((w) => sleeper.transactions(ctx.league.league_id, w)))).flat();
  const out = new Set<string>();
  for (const tx of txs) {
    if (tx.status !== "complete" || !tx.drops || Date.now() - tx.created > clearMs) continue;
    for (const id of Object.keys(tx.drops)) if (!ctx.rosteredBy.has(id)) out.add(id);
  }
  return out;
}

function slimRow<T extends PlayerRow>(r: T): T {
  // Drop empty fields; tool output size matters for chat context.
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v != null && v !== "")) as T;
}

/** Resolve a player name, preferring a match on one of the given rosters. */
function resolvePlayer(analyzer: Analyzer, ctx: LeagueContext, query: string, preferRosterIds: number[]): string {
  const matches = analyzer.findPlayers(ctx, query);
  const hit = matches.find((m) => preferRosterIds.includes(ctx.rosteredBy.get(m.id) ?? -1));
  if (!hit) {
    const owners = matches.map((m) => `${m.name} (${ctx.rosteredBy.has(m.id) ? "on another team" : "not rostered"})`);
    throw new Error(`"${query}" isn't on the expected roster${owners.length ? `; closest: ${owners.join(", ")}` : ""}`);
  }
  return hit.id;
}

export function registerTools(server: McpServer, sleeper: SleeperClient, cache: Cache) {
  const analyzer = new Analyzer(sleeper, cache);

  server.registerTool(
    "find_user_leagues",
    {
      title: "Find a Sleeper user's leagues",
      description:
        "Look up a Sleeper username and list their NFL leagues this season, with their team name, record and league_id in each. Call this first when you don't know the user's league_id.",
      inputSchema: {
        username: z.string().describe("Sleeper username"),
        season: z.string().optional().describe("Season year; defaults to the current season"),
      },
    },
    async ({ username, season }) => {
      const user = await sleeper.user(username);
      if (!user) return json({ error: `Sleeper user "${username}" not found` });
      const yr = season ?? (await sleeper.state()).season;
      const leagues = await sleeper.userLeagues(user.user_id, yr);
      const out = await Promise.all(
        leagues.map(async (l) => {
          const [rosters, users] = await Promise.all([sleeper.rosters(l.league_id), sleeper.leagueUsers(l.league_id)]);
          const mine = rosters.find((r) => r.owner_id === user.user_id || r.co_owners?.includes(user.user_id));
          const userMap = new Map(users.map((u) => [u.user_id, u]));
          return {
            league_id: l.league_id,
            name: l.name,
            teams: l.total_rosters,
            status: l.status,
            ppr: l.scoring_settings.rec ?? 0,
            superflex: l.roster_positions.includes("SUPER_FLEX"),
            type: ["redraft", "keeper", "dynasty"][l.settings.type ?? 0],
            my_team: mine ? { roster_id: mine.roster_id, name: teamName(mine, userMap), ...record(mine) } : null,
          };
        }),
      );
      return json({ user: { user_id: user.user_id, username: user.username, display_name: user.display_name }, season: yr, leagues: out });
    },
  );

  server.registerTool(
    "get_team_context",
    {
      title: "Get my team context",
      description:
        "Everything about the user's team in one call: league scoring and roster slots, waiver/FAAB status, record and standing, this week's matchup, the full roster with projections (this week, rest of season, fantasy playoffs), season and recent scoring, injuries and byes, the projected-optimal lineup vs the lineup currently set, and positional depth (starters needed vs rostered, upcoming bye/injury shortfalls). Start here for any waiver, start/sit, or roster question.",
      inputSchema: {
        league_id: z.string(),
        username: z.string().describe("Sleeper username of the team owner"),
        week: z.number().int().min(1).max(18).optional().describe("NFL week; defaults to the current week"),
      },
    },
    async ({ league_id, username, week }) => {
      const ctx = await analyzer.context(league_id, week);
      const roster = await analyzer.findRoster(ctx, username);
      const ranks = standings(ctx);
      const best = analyzer.lineup(ctx, roster);
      const reserve = new Set(roster.reserve ?? []);
      const currentStarters = new Set(roster.starters ?? []);

      const matchups = await sleeper.matchups(league_id, ctx.week).catch(() => []);
      const mine = matchups.find((m) => m.roster_id === roster.roster_id);
      const oppMatch = mine?.matchup_id != null ? matchups.find((m) => m.matchup_id === mine.matchup_id && m.roster_id !== roster.roster_id) : undefined;
      const oppRoster = oppMatch ? ctx.rosters.find((r) => r.roster_id === oppMatch.roster_id) : undefined;

      const nameOf = (id: string | null) => (id ? ctx.players[id]?.name ?? id : "(empty)");
      // Players whose game has kicked off can't be moved in or out of the lineup.
      const locked = (id: string) => gameStarted(ctx, ctx.players[id]?.team, ctx.week);
      const rows = rosterPlayerIds(roster).map((id) => analyzer.row(ctx, id));

      // News only for players with an injury designation, to keep the call fast.
      const injured = rows.filter((r) => r.injury).map((r) => r.id);
      const news = await loadNews(cache, ctx.players, injured, 2);

      const research = new Research(ctx);
      research.staleRankings();
      for (const r of rows) if (!reserve.has(r.id)) research.injury(r);
      const benchRows = rows.filter((r) => !best.starterIds.has(r.id) && !reserve.has(r.id));
      research.closeCalls(best.lineup, benchRows, (id, slot) =>
        (ctx.players[id]?.fantasy_positions ?? []).some((p) => SLOT_ELIGIBILITY[slot]?.includes(p)),
      );
      for (const r of rows) if (best.starterIds.has(r.id)) research.roleChange(r);
      for (const r of rows) if (best.starterIds.has(r.id)) research.disagreement(r);

      const roster_rows = rows
        .map((r) => ({
          ...slimRow(r),
          slot: reserve.has(r.id) ? "IR" : roster.taxi?.includes(r.id) ? "TAXI" : currentStarters.has(r.id) ? "starter" : "bench",
          in_optimal_lineup: best.starterIds.has(r.id),
          ...(news[r.id]?.length ? { news: newsSummary(news[r.id], false) } : {}),
        }))
        .sort((a, b) => a.pos.localeCompare(b.pos) || b.ros - a.ros);

      return json({
        data_as_of: asOf(ctx),
        league: {
          name: ctx.league.name,
          teams: ctx.league.total_rosters,
          roster_slots: ctx.league.roster_positions,
          scoring: scoringSummary(ctx.league.scoring_settings),
          waivers: waiverInfo(ctx, roster),
          trade_deadline_week: ctx.league.settings.trade_deadline,
          playoff_weeks: `${ctx.playoffStart}-${ctx.lastWeek}`,
          playoff_teams: ctx.league.settings.playoff_teams,
        },
        team: { name: teamName(roster, ctx.users), roster_id: roster.roster_id, standing: ranks.get(roster.roster_id), ...record(roster) },
        matchup: oppRoster
          ? {
              opponent: teamName(oppRoster, ctx.users),
              opponent_record: record(oppRoster),
              my_projected_optimal: round1(best.total),
              opponent_projected_optimal: round1(analyzer.lineup(ctx, oppRoster).total),
            }
          : null,
        optimal_lineup: best.lineup.map((l) => ({ slot: l.slot, player: nameOf(l.id), proj: round1(l.points) })),
        lineup_changes_suggested_by_projection: {
          bench_these: [...currentStarters].filter((id) => id !== "0" && !best.starterIds.has(id) && !locked(id)).map(nameOf),
          start_these: [...best.starterIds].filter((id) => !currentStarters.has(id) && !locked(id)).map(nameOf),
        },
        research_needed: research.result(),
        roster: roster_rows,
        positional_depth: positionalDepth(analyzer, ctx, roster),
        field_notes: {
          proj: `projected points week ${ctx.week}`,
          ros: `projected points weeks ${ctx.week}-${ctx.lastWeek} (rest of fantasy season)`,
          playoffs: `projected points in fantasy playoff weeks ${ctx.playoffStart}-${ctx.lastWeek}`,
          last3: "actual points in the player's team's last 3 games that kicked off, by week (null = team played, he didn't)",
        },
      });
    },
  );

  server.registerTool(
    "get_free_agents",
    {
      title: "Get available players in a league",
      description:
        "Players actually available in this league (not on any roster), with projections scored for this league, FantasyPros consensus ranks (weekly and rest of season, with expert spread), ESPN analyst ranks and rostered-% trend, usage (target/air-yard/rush share, expected vs actual points), season and recent production, injury, bye, depth-chart spot, Sleeper-wide trending adds, and whether they are on waivers. Pass username to also get that team's depth at the same positions, so you can judge who would be dropped. Try more than one sort_by: projections lag role changes that trending and usage catch.",
      inputSchema: {
        league_id: z.string(),
        username: z.string().optional().describe("If given, include this team's depth at the returned positions"),
        position: z.string().optional().describe("QB, RB, WR, TE, K, DEF, or an IDP position"),
        sort_by: z
          .enum(["ros", "week", "season_ppg", "trending", "playoffs", "fp_ros", "fp_week", "espn_rostered_change"])
          .default("ros")
          .describe("ros/week/playoffs = projected points; fp_* = FantasyPros consensus rank; espn_rostered_change = biggest risers in ESPN leagues"),
        limit: z.number().int().min(1).max(60).default(20),
        week: z.number().int().min(1).max(18).optional(),
      },
    },
    async ({ league_id, username, position, sort_by, limit, week }) => {
      const ctx = await analyzer.context(league_id, week);
      const [trending, waivers] = await Promise.all([sleeper.trending("add", 48, 300), onWaivers(sleeper, ctx)]);
      const trend = new Map(trending.map((t) => [t.player_id, t.count]));
      const pos = position?.toUpperCase();

      const rows = analyzer
        .freeAgentIds(ctx)
        .filter((id) => !pos || ctx.players[id].fantasy_positions.includes(pos))
        .map((id) => ({ ...analyzer.row(ctx, id), trending_adds_48h: trend.get(id) ?? 0, on_waivers: waivers.has(id) }));

      const key: Record<typeof sort_by, (r: (typeof rows)[number]) => number> = {
        ros: (r) => r.ros,
        week: (r) => r.proj,
        season_ppg: (r) => r.season.ppg,
        trending: (r) => r.trending_adds_48h,
        playoffs: (r) => r.playoffs,
        // Lower ECR is better; unranked players sort last.
        fp_ros: (r) => -(r.fp_ros?.ecr ?? 9999),
        fp_week: (r) => -(r.fp_week?.ecr ?? 9999),
        espn_rostered_change: (r) => r.espn?.rostered_change ?? -999,
      };
      rows.sort((a, b) => key[sort_by](b) - key[sort_by](a));
      const top = rows.slice(0, limit);
      const news = await loadNews(cache, ctx.players, top.map((r) => r.id), 1);

      // Research prompts for the candidates Claude is most likely to recommend.
      const research = new Research(ctx);
      research.staleRankings();
      const injuryOf = (id: string) => analyzer.row(ctx, id).injury;
      for (const r of top.slice(0, 8)) {
        research.injury(r);
        if (r.trending_adds_48h >= 10_000) research.trending(r, r.trending_adds_48h, depthAhead(ctx.players, r.id, injuryOf), news[r.id]);
        research.roleChange(r);
        research.disagreement(r);
      }

      let my_depth: unknown;
      if (username) {
        const roster = await analyzer.findRoster(ctx, username);
        const depth = positionalDepth(analyzer, ctx, roster);
        const shown = new Set(top.map((r) => r.pos));
        my_depth = Object.fromEntries(Object.entries(depth).filter(([p]) => shown.has(p)));
      }

      return json({
        data_as_of: asOf(ctx),
        waivers: waiverInfo(ctx),
        sorted_by: sort_by,
        research_needed: research.result(),
        available: top.map((r) => ({ ...slimRow(r), ...(news[r.id]?.length ? { latest_news: newsSummary(news[r.id], false)![0] } : {}) })),
        my_depth,
      });
    },
  );

  server.registerTool(
    "get_player_report",
    {
      title: "Get detailed player reports",
      description:
        "Deep view of 1-5 players by name: league-scored game log for every week this season (with snap %, targets, carries, target share and expected points per game), projections and opponents for the next 4 weeks, rest-of-season and playoff projections, FantasyPros and ESPN ranks, ESPN's written outlook, injury, depth chart, and which team in the league rosters them. Use for start/sit, 'A or B?' and trade questions.",
      inputSchema: {
        league_id: z.string(),
        players: z.array(z.string()).min(1).max(5).describe("Player names (or Sleeper player IDs)"),
        week: z.number().int().min(1).max(18).optional(),
      },
    },
    async ({ league_id, players, week }) => {
      const ctx = await analyzer.context(league_id, week);
      const scoring = ctx.league.scoring_settings;
      // Include the current week once games have kicked off; per player we only show it if his game has.
      const lastWeek = ctx.weekStarted ? ctx.week : ctx.week - 1;
      const pastWeeks = Array.from({ length: Math.max(0, lastWeek) }, (_, i) => i + 1);
      // Recent weeks were already fetched by context() (current week with a short live TTL).
      const fetched = new Map(ctx.recentStats.map((r) => [r.week, r.stats]));
      const weekly = await Promise.all(
        pastWeeks.map((w) => fetched.get(w) ?? sleeper.stats(ctx.season, w, ctx.positions)),
      );

      const found = players.map((q) => ({ q, matches: analyzer.findPlayers(ctx, q) }));
      const news = await loadNews(cache, ctx.players, found.flatMap((f) => (f.matches[0] ? [f.matches[0].id] : [])), 3);
      const research = new Research(ctx);
      research.staleRankings();
      const injuryOf = (id: string) => analyzer.row(ctx, id).injury;

      const reports = found.map(({ q, matches }) => {
        if (!matches.length) return { query: q, error: "no player found" };
        const p = matches[0];
        const row = analyzer.row(ctx, p.id);
        const ahead = depthAhead(ctx.players, p.id, injuryOf);
        research.injury(row);
        research.roleChange(row);
        research.disagreement(row);
        const owner = ctx.rosteredBy.get(p.id);
        const ownerRoster = owner != null ? ctx.rosters.find((r) => r.roster_id === owner) : undefined;
        const upcoming = [0, 1, 2, 3]
          .map((d) => ctx.week + d)
          .filter((w) => w <= ctx.lastWeek)
          .map((w) => ({
            week: w,
            opp: p.team ? analyzer.opponent(ctx, p.team, w) : null,
            proj: round1(scorePoints(ctx.weeklyProj.get(w)?.[p.id]?.stats, scoring)),
          }));
        const espn = ctx.ext.espn?.players[p.id];
        const usageByWeek = new Map((ctx.ext.usage?.games[p.id] ?? []).map((g) => [g.week, g]));
        return {
          query: q,
          ...slimRow(row),
          injury_detail: [p.injury_body_part, p.injury_notes].filter(Boolean).join(" - ") || undefined,
          years_exp: p.years_exp,
          rostered_by: ownerRoster ? teamName(ownerRoster, ctx.users) : "available",
          news: newsSummary(news[p.id], true),
          depth_chart_ahead: ahead.length ? ahead : undefined,
          espn_outlook: espn?.outlook ? { week: espn.outlook_week, text: espn.outlook } : undefined,
          game_log: pastWeeks.flatMap((w, i): Record<string, unknown>[] => {
            // Current week only once his game has kicked off.
            if (w === ctx.week && !gameStarted(ctx, p.team, w)) return [];
            const status = w === ctx.week && ctx.gameStatus.get(`${w}:${p.team}`) === "in_game" ? { game: "in progress" } : {};
            if (p.team && ctx.byes.get(p.team) === w) return [{ week: w, pts: null, note: "bye" }];
            const s = weekly[i][p.id];
            if (!s) return [{ week: w, pts: null, ...status }];
            const u = usageByWeek.get(w);
            return [{
              week: w,
              ...status,
              pts: round1(scorePoints(s, scoring)),
              ...(s.off_snp != null && s.tm_off_snp ? { snap_pct: round1((100 * s.off_snp) / s.tm_off_snp) } : {}),
              ...(s.rec_tgt != null ? { tgt: s.rec_tgt, rec: s.rec ?? 0 } : {}),
              ...(s.rush_att != null ? { rush_att: s.rush_att } : {}),
              ...(u
                ? {
                    xfp: round1(u.xfp),
                    ...(u.team_tgt ? { tgt_share: round1((100 * u.tgt) / u.team_tgt) } : {}),
                  }
                : {}),
            }];
          }),
          upcoming,
          other_matches: matches.slice(1).map((m) => `${m.name} (${m.position}, ${m.team ?? "FA"})`),
        };
      });
      return json({ data_as_of: asOf(ctx), research_needed: research.result(), players: reports });
    },
  );

  server.registerTool(
    "get_league_landscape",
    {
      title: "Get league landscape",
      description:
        "Every team in the league: record, standing, FAAB remaining or waiver position, projected-optimal score this week, rest-of-season starter strength by position (to spot who needs what, for waiver competition and trade partners), plus recent adds/drops/trades with FAAB bids.",
      inputSchema: {
        league_id: z.string(),
        weeks_back: z.number().int().min(0).max(4).default(2).describe("How many past weeks of transactions to include"),
      },
    },
    async ({ league_id, weeks_back }) => {
      const ctx = await analyzer.context(league_id);
      const ranks = standings(ctx);
      const slots = startingSlots(ctx.league.roster_positions);

      const teams = ctx.rosters
        .map((r) => {
          const ids = (r.players ?? []).filter((id) => !(r.reserve ?? []).includes(id));
          const rows = ids.map((id) => analyzer.row(ctx, id));
          // Rest-of-season strength of the top N players at each position, N = dedicated slots (min 1).
          const strength = Object.fromEntries(
            ctx.positions.map((pos) => {
              const n = Math.max(1, slots.filter((s) => s === pos).length);
              const top = rows
                .filter((x) => ctx.players[x.id]?.fantasy_positions.includes(pos))
                .sort((a, b) => b.ros - a.ros)
                .slice(0, n);
              return [pos, { ros_top: round1(top.reduce((s, x) => s + x.ros, 0)), count: rows.filter((x) => x.pos === pos).length }];
            }),
          );
          return {
            team: teamName(r, ctx.users),
            roster_id: r.roster_id,
            standing: ranks.get(r.roster_id),
            ...record(r),
            waivers: waiverInfo(ctx, r),
            projected_optimal_this_week: round1(analyzer.lineup(ctx, r).total),
            position_strength: strength,
          };
        })
        .sort((a, b) => (a.standing ?? 0) - (b.standing ?? 0));

      // Rank each team's strength per position (1 = strongest) so needs stand out.
      for (const pos of ctx.positions) {
        const order = [...teams].sort((a, b) => b.position_strength[pos].ros_top - a.position_strength[pos].ros_top);
        order.forEach((t, i) => Object.assign(t.position_strength[pos], { league_rank: i + 1 }));
      }

      const weeks = Array.from({ length: weeks_back + 1 }, (_, i) => ctx.week - i).filter((w) => w >= 1);
      const txs = (await Promise.all(weeks.map((w) => sleeper.transactions(league_id, w)))).flat();
      const byRoster = new Map(ctx.rosters.map((r) => [r.roster_id, teamName(r, ctx.users)]));
      const name = (id: string) => ctx.players[id]?.name ?? id;
      const transactions = txs
        .filter((t) => t.status === "complete")
        .sort((a, b) => b.created - a.created)
        .map((t) => ({
          week: t.leg,
          type: t.type,
          date: new Date(t.created).toISOString().slice(0, 10),
          teams: t.roster_ids.map((id) => byRoster.get(id)),
          adds: t.adds ? Object.entries(t.adds).map(([id, rid]) => `${name(id)} -> ${byRoster.get(rid)}`) : [],
          drops: t.drops ? Object.entries(t.drops).map(([id, rid]) => `${name(id)} <- ${byRoster.get(rid)}`) : [],
          ...(t.settings?.waiver_bid != null ? { faab_bid: t.settings.waiver_bid } : {}),
        }));

      return json({ data_as_of: asOf(ctx), teams, transactions });
    },
  );

  server.registerTool(
    "get_rankings",
    {
      title: "Get consensus rankings for a position",
      description:
        "FantasyPros expert consensus rankings (weekly or rest of season) for one position, side by side with ESPN analysts' average rank and this league's scored projections, plus who rosters each player in the league. Big gaps between sources, or a large expert spread (sd, best-worst), mark players where opinions differ and research is worth it.",
      inputSchema: {
        league_id: z.string(),
        position: z.string().describe("QB, RB, WR, TE, K, DEF, DL, LB, DB"),
        type: z.enum(["week", "ros"]).default("ros"),
        limit: z.number().int().min(1).max(100).default(40),
        only_available: z.boolean().default(false).describe("Only players not rostered in this league"),
      },
    },
    async ({ league_id, position, type, limit, only_available }) => {
      const ctx = await analyzer.context(league_id);
      const fp = ctx.ext.fp;
      if (!fp) return json({ error: "FantasyPros rankings are unavailable right now", data_as_of: asOf(ctx) });
      const pos = position.toUpperCase();
      const source = type === "week" ? fp.weekly : fp.ros;
      const byRoster = new Map(ctx.rosters.map((r) => [r.roster_id, teamName(r, ctx.users)]));

      const rows = Object.entries(source)
        .filter(([id]) => ctx.players[id]?.fantasy_positions.includes(pos))
        .filter(([id]) => !only_available || !ctx.rosteredBy.has(id))
        .sort(([, a], [, b]) => a.ecr - b.ecr)
        .slice(0, limit)
        .map(([id, r]) => {
          const row = analyzer.row(ctx, id);
          const owner = ctx.rosteredBy.get(id);
          return {
            name: row.name,
            team: row.team,
            fp_rank: r.rank,
            ecr: r.ecr,
            sd: r.sd,
            range: r.best != null && r.worst != null ? `${r.best}-${r.worst}` : undefined,
            espn_avg_rank: row.espn?.analyst_rank_avg,
            proj: type === "week" ? row.proj : row.ros,
            injury: row.injury ?? undefined,
            rostered_by: owner != null ? byRoster.get(owner) : "available",
          };
        });
      return json({ data_as_of: asOf(ctx), position: pos, type, rankings: rows });
    },
  );

  server.registerTool(
    "get_trending_players",
    {
      title: "Get trending adds/drops across Sleeper",
      description:
        "Players being added or dropped most across all Sleeper leagues recently, each with its latest ESPN news headline and the teammates ahead of it on the depth chart (with injury status), which usually explains a spike. Pass league_id to see whether each is available in that league. Spikes the data can't explain are listed in research_needed: web search those before drawing conclusions.",
      inputSchema: {
        type: z.enum(["add", "drop"]).default("add"),
        hours: z.number().int().min(1).max(168).default(24),
        limit: z.number().int().min(1).max(50).default(25),
        league_id: z.string().optional(),
      },
    },
    async ({ type, hours, limit, league_id }) => {
      const [trending, players] = await Promise.all([sleeper.trending(type, hours, limit), sleeper.players()]);
      const ctx = league_id ? await analyzer.context(league_id) : undefined;
      const byRoster = ctx ? new Map(ctx.rosters.map((r) => [r.roster_id, teamName(r, ctx.users)])) : undefined;
      // Live injury status when we have a league context; otherwise the daily player DB.
      const injuryOf = (id: string) => (ctx ? analyzer.row(ctx, id).injury : players[id]?.injury_status ?? null);
      const news = await loadNews(cache, players, trending.map((t) => t.player_id), 1);
      const research = new Research(ctx);

      const rows = trending.map((t) => {
        const p = players[t.player_id];
        const owner = ctx?.rosteredBy.get(t.player_id);
        const ahead = depthAhead(players, t.player_id, injuryOf);
        if (type === "add") research.trending({ id: t.player_id, name: p?.name ?? t.player_id, team: p?.team }, t.count, ahead, news[t.player_id]);
        return {
          name: p?.name ?? t.player_id,
          pos: p?.position,
          team: p?.team,
          count: t.count,
          injury: injuryOf(t.player_id) ?? undefined,
          depth_chart:
            p?.depth_chart_position && p.depth_chart_order ? `${p.depth_chart_position}${p.depth_chart_order}` : undefined,
          ahead_on_depth_chart: ahead.length ? ahead : undefined,
          latest_news: newsSummary(news[t.player_id], false)?.[0],
          ...(ctx
            ? { in_league: owner != null ? `rostered by ${byRoster!.get(owner)}` : "available", ros: analyzer.row(ctx, t.player_id).ros }
            : {}),
        };
      });
      return json({ type, hours, fetched_at: new Date().toISOString(), research_needed: research.result(), players: rows });
    },
  );

  server.registerTool(
    "evaluate_trade",
    {
      title: "Evaluate a trade",
      description:
        "Evaluate a proposed trade for both teams. Computes each side's change in projected optimal-lineup points for the rest of the season and the fantasy playoffs (bye overlaps and positional need included, bench players add ~0 unless they'd start), FantasyCalc market value in/out, roster-limit forced drops or the open bench spot, and new positional holes. Returns inputs, not a verdict. Judge by lineup points for this roster first, market value second, and check the partner's side: trades that only help you rarely get accepted.",
      inputSchema: {
        league_id: z.string(),
        username: z.string().describe("Sleeper username of the team owner"),
        give: z.array(z.string()).min(1).describe("Player names you send"),
        get: z.array(z.string()).min(1).describe("Player names you receive"),
        partner: z.string().optional().describe("Partner team name or owner username; inferred from who owns the `get` players if omitted"),
      },
    },
    async ({ league_id, username, give, get, partner }) => {
      const ctx = await analyzer.context(league_id);
      const mine = await analyzer.findRoster(ctx, username);
      const others = ctx.rosters.filter((r) => r.roster_id !== mine.roster_id);

      let theirs: Roster | undefined;
      if (partner) {
        const q = partner.toLowerCase();
        theirs = others.find((r) => {
          const u = r.owner_id ? ctx.users.get(r.owner_id) : undefined;
          return [teamName(r, ctx.users), u?.display_name].some((n) => n?.toLowerCase() === q);
        });
        if (!theirs) return json({ error: `No other team matches "${partner}"`, teams: others.map((r) => teamName(r, ctx.users)) });
      }

      try {
        const giveIds = give.map((q) => resolvePlayer(analyzer, ctx, q, [mine.roster_id]));
        const getIds = get.map((q) => resolvePlayer(analyzer, ctx, q, (theirs ? [theirs] : others).map((r) => r.roster_id)));
        const owners = new Set(getIds.map((id) => ctx.rosteredBy.get(id)));
        if (owners.size > 1) return json({ error: "The players you want to get are on different teams; a trade has one partner" });
        theirs ??= others.find((r) => r.roster_id === [...owners][0])!;

        const { me, them } = evaluateTrade(
          analyzer,
          ctx,
          { name: teamName(mine, ctx.users), roster: mine },
          { name: teamName(theirs, ctx.users), roster: theirs },
          giveIds,
          getIds,
        );

        const deadline = ctx.league.settings.trade_deadline;
        const passed = deadline > 0 && ctx.week > deadline;
        const winner = (mineVal: number | null, theirVal: number | null) =>
          mineVal == null || theirVal == null || Math.abs(mineVal - theirVal) < 0.05 ? "even" : mineVal > theirVal ? "me" : "them";
        const players = [...giveIds, ...getIds].map((id) => slimRow(analyzer.row(ctx, id)));

        const research = new Research(ctx);
        research.staleRankings();
        for (const r of players) research.injury(r as PlayerRow);

        return json({
          data_as_of: asOf(ctx),
          trade_deadline_week: deadline || null,
          trade_deadline_passed: passed,
          me,
          them,
          players: { give: players.slice(0, giveIds.length), get: players.slice(giveIds.length) },
          research_needed: research.result(),
          verdict_inputs: {
            market_value_winner: me.market_delta == null ? "unknown (FantasyCalc unavailable)" : winner(me.market_delta, -me.market_delta),
            ros_lineup_winner: winner(me.lineup_delta_ros, them.lineup_delta_ros),
            playoff_lineup_winner: winner(me.lineup_delta_playoffs, them.lineup_delta_playoffs),
            both_sides_gain_lineup_points: me.lineup_delta_ros > 0 && them.lineup_delta_ros > 0,
          },
        });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
