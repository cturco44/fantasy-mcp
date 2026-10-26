import type { Analyzer, LeagueContext } from "./league.js";
import { SLOT_ELIGIBILITY, optimalLineup, round1, scorePoints, startingSlots } from "./scoring.js";
import type { Roster } from "./sleeper.js";

/** Starter demand vs supply per position: the core input for "do I need this position?" */
export function positionalDepth(analyzer: Analyzer, ctx: LeagueContext, roster: Roster) {
  const slots = startingSlots(ctx.league.roster_positions);
  const reserve = new Set(roster.reserve ?? []);
  const rows = (roster.players ?? []).filter((id) => !reserve.has(id)).map((id) => analyzer.row(ctx, id));
  const nextWeeks = [0, 1, 2, 3].map((d) => ctx.week + d).filter((w) => w <= ctx.lastWeek);

  return Object.fromEntries(
    ctx.positions.map((pos) => {
      const players = rows.filter((r) => ctx.players[r.id]?.fantasy_positions.includes(pos)).sort((a, b) => b.ros - a.ros);
      const dedicated = slots.filter((s) => s === pos).length;
      const flex = slots.filter((s) => s !== pos && SLOT_ELIGIBILITY[s]?.includes(pos)).length;
      const byeShortfalls = nextWeeks
        .map((w) => ({ week: w, available: players.filter((p) => p.bye !== w && p.injury !== "Out" && p.injury !== "IR").length }))
        .filter((x) => x.available < dedicated);
      return [
        pos,
        {
          dedicated_slots: dedicated,
          flex_slots_eligible: flex,
          rostered: players.length,
          players: players.map(
            (p) =>
              `${p.name} (ros ${p.ros}${p.fp_ros ? `, FP ROS ${p.fp_ros.rank}` : ""}, bye ${p.bye ?? "-"}${p.injury ? `, ${p.injury}` : ""})`,
          ),
          shortfall_weeks: byeShortfalls,
        },
      ];
    }),
  );
}

interface PlayerWeeks {
  positions: string[];
  /** League-scored projection per remaining week, index 0 = ctx.week. */
  pts: number[];
  /** Bye, or Out/IR in the current week. */
  out: boolean[];
}

const tables = new WeakMap<LeagueContext, Map<string, PlayerWeeks>>();

/** Per-player weekly points/availability, computed once per context and reused across lineup evaluations. */
function playerWeeks(ctx: LeagueContext, id: string): PlayerWeeks {
  let cache = tables.get(ctx);
  if (!cache) tables.set(ctx, (cache = new Map()));
  let pw = cache.get(id);
  if (!pw) {
    const p = ctx.players[id];
    const weeks = [...ctx.weeklyProj.keys()].sort((a, b) => a - b);
    const bye = p?.team ? ctx.byes.get(p.team) : undefined;
    pw = {
      positions: p?.fantasy_positions ?? [],
      pts: weeks.map((w) => scorePoints(ctx.weeklyProj.get(w)?.[id]?.stats, ctx.league.scoring_settings)),
      out: weeks.map((w) => {
        if (w === bye) return true;
        if (w !== ctx.week) return false;
        const inj = ctx.weeklyProj.get(w)?.[id]?.injury_status ?? p?.injury_status;
        return inj === "Out" || inj === "IR";
      }),
    };
    cache.set(id, pw);
  }
  return pw;
}

export interface LineupValue {
  ros: number;
  playoffs: number;
  byWeek: number[];
  /** Weeks each player is in the optimal lineup. */
  starts: Map<string, number>;
}

/**
 * Sum over weeks ctx.week..ctx.lastWeek of the optimal lineup's projected points, plus the
 * fantasy-playoff weeks separately. `playerIds` should be active players only (no IR/taxi).
 */
export function rosLineupPoints(ctx: LeagueContext, playerIds: string[]): LineupValue {
  const slots = startingSlots(ctx.league.roster_positions);
  const weeks = [...ctx.weeklyProj.keys()].sort((a, b) => a - b);
  const pws = playerIds.map((id) => [id, playerWeeks(ctx, id)] as const);
  const starts = new Map<string, number>();
  const byWeek: number[] = [];
  let ros = 0;
  let playoffs = 0;
  weeks.forEach((w, i) => {
    const { total, starterIds } = optimalLineup(
      slots,
      pws.map(([id, pw]) => ({ id, positions: pw.positions, points: pw.pts[i], unavailable: pw.out[i] })),
    );
    byWeek.push(total);
    ros += total;
    if (w >= ctx.playoffStart) playoffs += total;
    for (const id of starterIds) starts.set(id, (starts.get(id) ?? 0) + 1);
  });
  return { ros, playoffs, byWeek, starts };
}

/** Active (non-IR, non-taxi) players: the ones who can start. */
export function activeIds(r: Roster): string[] {
  const inactive = new Set([...(r.reserve ?? []), ...(r.taxi ?? [])]);
  return (r.players ?? []).filter((id) => !inactive.has(id));
}

/** Max active players: every slot except IR/TAXI. */
export function rosterLimit(ctx: LeagueContext): number {
  return ctx.league.roster_positions.filter((s) => s !== "IR" && s !== "TAXI").length;
}

function marketValue(ctx: LeagueContext, id: string): number | null {
  const t = ctx.ext.trade;
  return t ? t.players[id]?.value ?? 0 : null;
}

function rosOf(ctx: LeagueContext, id: string): number {
  return playerWeeks(ctx, id).pts.reduce((s, x) => s + x, 0);
}

/** Best free agent at a flex-eligible position by ROS projection (what an open bench spot is worth). */
function bestFreeAgent(analyzer: Analyzer, ctx: LeagueContext) {
  const flexPos = new Set(["RB", "WR", "TE"]);
  let best: { id: string; ros: number } | undefined;
  for (const id of analyzer.freeAgentIds(ctx)) {
    if (!ctx.players[id].fantasy_positions.some((p) => flexPos.has(p))) continue;
    if (!ctx.weeklyProj.get(ctx.week)?.[id]) continue;
    const ros = rosOf(ctx, id);
    if (!best || ros > best.ros) best = { id, ros };
  }
  return best;
}

export interface TradeSide {
  team: string;
  gives: string[];
  gets: string[];
  lineup_ros_before: number;
  lineup_ros_after: number;
  lineup_delta_ros: number;
  lineup_delta_playoffs: number;
  /** FantasyCalc value; null when that source is unavailable. */
  market_value_out: number | null;
  market_value_in: number | null;
  market_delta: number | null;
  roster_count_before: number;
  roster_count_after: number;
  roster_limit: number;
  /** Bench players who would have to be dropped to fit the roster limit (already removed from the lineup math). */
  forced_drops?: { name: string; ros: number; market_value: number | null }[];
  open_bench_spots?: number;
  /** An open spot is valued as the best flex-eligible free agent; lineup gain is on top of lineup_delta_ros. */
  free_agent_for_open_spot?: { name: string; ros: number; lineup_gain_ros: number; note: string };
  positional_depth_after: Record<string, { rostered: number; dedicated_slots: number; shortfall_weeks: number[] }>;
  new_holes: string[];
}

function depthSummary(analyzer: Analyzer, ctx: LeagueContext, roster: Roster) {
  return Object.fromEntries(
    Object.entries(positionalDepth(analyzer, ctx, roster)).map(([pos, d]) => [
      pos,
      { rostered: d.rostered, dedicated_slots: d.dedicated_slots, shortfall_weeks: d.shortfall_weeks.map((s) => s.week) },
    ]),
  );
}

function evaluateSide(
  analyzer: Analyzer,
  ctx: LeagueContext,
  team: string,
  roster: Roster,
  out: string[],
  incoming: string[],
): TradeSide {
  const name = (id: string) => ctx.players[id]?.name ?? id;
  const outSet = new Set(out);
  const limit = rosterLimit(ctx);
  const before = activeIds(roster);
  const beforeValue = rosLineupPoints(ctx, before);

  let after = [...before.filter((id) => !outSet.has(id)), ...incoming];
  let afterValue = rosLineupPoints(ctx, after);

  // Over the roster limit: drop the players who contribute least (fewest starts, then lowest market value, then ROS).
  const forced: NonNullable<TradeSide["forced_drops"]> = [];
  const protectedIds = new Set(incoming);
  while (after.length > limit) {
    const victim = after
      .filter((id) => !protectedIds.has(id))
      .sort(
        (a, b) =>
          (afterValue.starts.get(a) ?? 0) - (afterValue.starts.get(b) ?? 0) ||
          (marketValue(ctx, a) ?? 0) - (marketValue(ctx, b) ?? 0) ||
          rosOf(ctx, a) - rosOf(ctx, b),
      )[0];
    if (!victim) break;
    forced.push({ name: name(victim), ros: round1(rosOf(ctx, victim)), market_value: marketValue(ctx, victim) });
    after = after.filter((id) => id !== victim);
    afterValue = rosLineupPoints(ctx, after);
  }

  const sum = (ids: string[]) => (ctx.ext.trade ? ids.reduce((s, id) => s + (marketValue(ctx, id) ?? 0), 0) : null);
  const valueOut = sum(out);
  const valueIn = sum(incoming);

  // A consolidation trade (fewer players back) frees a bench spot.
  const openSpots = after.length < before.length ? limit - after.length : 0;
  const side: TradeSide = {
    team,
    gives: out.map(name),
    gets: incoming.map(name),
    lineup_ros_before: round1(beforeValue.ros),
    lineup_ros_after: round1(afterValue.ros),
    lineup_delta_ros: round1(afterValue.ros - beforeValue.ros),
    lineup_delta_playoffs: round1(afterValue.playoffs - beforeValue.playoffs),
    market_value_out: valueOut,
    market_value_in: valueIn,
    market_delta: valueOut != null && valueIn != null ? valueIn - valueOut : null,
    roster_count_before: before.length,
    roster_count_after: after.length,
    roster_limit: limit,
    positional_depth_after: {},
    new_holes: [],
  };
  if (forced.length) side.forced_drops = forced;

  if (openSpots > 0) {
    side.open_bench_spots = openSpots;
    const fa = bestFreeAgent(analyzer, ctx);
    if (fa) {
      const withFa = rosLineupPoints(ctx, [...after, fa.id]);
      side.free_agent_for_open_spot = {
        name: name(fa.id),
        ros: round1(fa.ros),
        lineup_gain_ros: round1(withFa.ros - afterValue.ros),
        note: "Best flex-eligible free agent, as the value of the spot this trade opens; not included in lineup_delta_ros.",
      };
    }
  }

  // Depth after: rebuild the roster with the trade applied.
  const reserve = (roster.reserve ?? []).filter((id) => !outSet.has(id));
  const taxi = (roster.taxi ?? []).filter((id) => !outSet.has(id));
  const afterRoster: Roster = { ...roster, players: [...after, ...reserve, ...taxi], reserve, taxi };
  const depthBefore = depthSummary(analyzer, ctx, roster);
  side.positional_depth_after = depthSummary(analyzer, ctx, afterRoster);
  for (const [pos, d] of Object.entries(side.positional_depth_after)) {
    const b = depthBefore[pos];
    if (d.rostered < d.dedicated_slots && d.rostered < b.rostered) {
      side.new_holes.push(`${pos}: ${d.rostered} rostered for ${d.dedicated_slots} starting slot(s) (was ${b.rostered})`);
    } else if (d.shortfall_weeks.length > b.shortfall_weeks.length) {
      side.new_holes.push(`${pos}: short of starters in week(s) ${d.shortfall_weeks.filter((w) => !b.shortfall_weeks.includes(w)).join(", ")} (bye/injury)`);
    }
  }
  return side;
}

/** Evaluate a trade from both teams' perspectives. `give` is what roster A sends to B. */
export function evaluateTrade(
  analyzer: Analyzer,
  ctx: LeagueContext,
  teamA: { name: string; roster: Roster },
  teamB: { name: string; roster: Roster },
  give: string[],
  get: string[],
) {
  return {
    me: evaluateSide(analyzer, ctx, teamA.name, teamA.roster, give, get),
    them: evaluateSide(analyzer, ctx, teamB.name, teamB.roster, get, give),
  };
}
