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

/** Lineup value of a roster after a trade, dropping the least useful players if it exceeds the roster limit. */
function applyTrade(ctx: LeagueContext, before: string[], afterIds: string[], incoming: string[]) {
  const limit = rosterLimit(ctx);
  const name = (id: string) => ctx.players[id]?.name ?? id;
  let after = afterIds;
  let afterValue = rosLineupPoints(ctx, after);
  // Over the roster limit: drop the players who contribute least (fewest starts, then lowest market value, then ROS).
  const forced: { name: string; ros: number; market_value: number | null }[] = [];
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
  return { after, afterValue, forced };
}

function afterIdsOf(before: string[], out: string[], incoming: string[]): string[] {
  const outSet = new Set(out);
  return [...before.filter((id) => !outSet.has(id)), ...incoming];
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

  const { after, afterValue, forced } = applyTrade(ctx, before, afterIdsOf(before, out, incoming), incoming);
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

export interface TradeIdea {
  partner: string;
  give: string[];
  get: string[];
  my_gain_ros: number;
  my_gain_playoffs: number;
  their_gain_ros: number;
  their_gain_playoffs: number;
  market_me_gives: number | null;
  market_me_gets: number | null;
  market_gap_pct: number | null;
  notes: string[];
  why_it_works_for_them: string;
}

const MAX_MARKET_GAP = 0.2;
const SIDE_CAP = 10;

/** Per-team starter strength at each position (sum of top-N ROS), to say who needs what. */
function positionRanks(ctx: LeagueContext): Map<number, Record<string, { rank: number; of: number }>> {
  const slots = startingSlots(ctx.league.roster_positions);
  const strength = new Map<number, Record<string, number>>();
  for (const r of ctx.rosters) {
    const by: Record<string, number> = {};
    for (const pos of ctx.positions) {
      const n = Math.max(1, slots.filter((sl) => sl === pos).length);
      by[pos] = activeIds(r)
        .filter((id) => ctx.players[id]?.fantasy_positions.includes(pos))
        .map((id) => rosOf(ctx, id))
        .sort((a, b) => b - a)
        .slice(0, n)
        .reduce((sum, x) => sum + x, 0);
    }
    strength.set(r.roster_id, by);
  }
  const out = new Map<number, Record<string, { rank: number; of: number }>>();
  for (const r of ctx.rosters) {
    out.set(
      r.roster_id,
      Object.fromEntries(
        ctx.positions.map((pos) => {
          const mine = strength.get(r.roster_id)![pos];
          const rank = 1 + ctx.rosters.filter((o) => strength.get(o.roster_id)![pos] > mine).length;
          return [pos, { rank, of: ctx.rosters.length }];
        }),
      ),
    );
  }
  return out;
}

function subsets(ids: string[], size: number): string[][] {
  if (size === 1) return ids.map((id) => [id]);
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) out.push([ids[i], ids[j]]);
  return out;
}

export interface FindOptions {
  targetPosition?: string;
  offerPosition?: string;
  maxResults: number;
}

/** Win-win 1-for-1, 2-for-1 and 1-for-2 swaps with every other team that are close enough in market value to get accepted. */
export function findTradePartners(analyzer: Analyzer, ctx: LeagueContext, mine: Roster, teamName: (r: Roster) => string, opts: FindOptions) {
  const skipPos = new Set(["K", "DEF"].filter((p) => p !== opts.targetPosition && p !== opts.offerPosition));
  const fa = bestFreeAgent(analyzer, ctx);
  const limit = rosterLimit(ctx);
  const hasMarket = !!ctx.ext.trade;
  const ranks = positionRanks(ctx);

  // Normalise ROS and market value so one cap ranks both.
  const rostered = ctx.rosters.flatMap(activeIds);
  const maxRos = Math.max(1, ...rostered.map((id) => rosOf(ctx, id)));
  const maxVal = Math.max(1, ...rostered.map((id) => marketValue(ctx, id) ?? 0));
  const weight = (id: string) => Math.max(rosOf(ctx, id) / maxRos, (marketValue(ctx, id) ?? 0) / maxVal);
  const tradeable = (r: Roster) =>
    activeIds(r)
      .filter((id) => ctx.players[id]?.fantasy_positions.some((p) => !skipPos.has(p)))
      .sort((a, b) => weight(b) - weight(a))
      .slice(0, SIDE_CAP);
  const hasPos = (ids: string[], pos?: string) => !pos || ids.some((id) => ctx.players[id]?.fantasy_positions.includes(pos));

  const myActive = activeIds(mine);
  const myBase = rosLineupPoints(ctx, myActive);
  const myPool = tradeable(mine);
  const ideas: (TradeIdea & { _score: number })[] = [];

  for (const other of ctx.rosters) {
    if (other.roster_id === mine.roster_id) continue;
    const theirActive = activeIds(other);
    const theirBase = rosLineupPoints(ctx, theirActive);
    const theirPool = tradeable(other);
    const sizes: [number, number][] = [[1, 1], [2, 1], [1, 2]];

    const side = (base: string[], baseValue: LineupValue, out: string[], incoming: string[]) => {
      const { after, afterValue, forced } = applyTrade(ctx, base, afterIdsOf(base, out, incoming), incoming);
      let ros = afterValue.ros;
      // A consolidation frees a spot worth the best free agent.
      if (fa && after.length < base.length && after.length < limit) ros = rosLineupPoints(ctx, [...after, fa.id]).ros;
      return { ros: ros - baseValue.ros, playoffs: afterValue.playoffs - baseValue.playoffs, forced };
    };

    for (const [g, r] of sizes) {
      for (const give of subsets(myPool, g)) {
        if (!hasPos(give, opts.offerPosition)) continue;
        const valueOut = give.reduce((s, id) => s + (marketValue(ctx, id) ?? 0), 0);
        for (const get of subsets(theirPool, r)) {
          if (!hasPos(get, opts.targetPosition)) continue;
          const valueIn = get.reduce((s, id) => s + (marketValue(ctx, id) ?? 0), 0);
          const gap = Math.abs(valueOut - valueIn) / Math.max(valueOut, valueIn, 1);
          if (hasMarket && gap > MAX_MARKET_GAP) continue;

          const mineSide = side(myActive, myBase, give, get);
          if (mineSide.ros <= 0) continue;
          const theirSide = side(theirActive, theirBase, get, give);
          if (theirSide.ros <= 0) continue;

          const notes = [
            ...mineSide.forced.map((d) => `you'd drop ${d.name}`),
            ...theirSide.forced.map((d) => `they'd drop ${d.name}`),
          ];
          const posOf = (id: string) => ctx.players[id]?.position ?? "?";
          const theirIncoming = [...new Set(give.map(posOf))].filter((p) => ranks.get(other.roster_id)?.[p]);
          const theirOutgoing = [...new Set(get.map(posOf))].filter((p) => ranks.get(other.roster_id)?.[p]);
          const rk = ranks.get(other.roster_id)!;
          const why = [
            ...theirIncoming.map((p) => `adds ${p} (they rank ${rk[p].rank}/${rk[p].of} at ${p})`),
            ...theirOutgoing.map((p) => `gives from ${p} (they rank ${rk[p].rank}/${rk[p].of})`),
          ].join("; ");

          ideas.push({
            partner: teamName(other),
            give: give.map((id) => ctx.players[id].name),
            get: get.map((id) => ctx.players[id].name),
            my_gain_ros: round1(mineSide.ros),
            my_gain_playoffs: round1(mineSide.playoffs),
            their_gain_ros: round1(theirSide.ros),
            their_gain_playoffs: round1(theirSide.playoffs),
            market_me_gives: hasMarket ? valueOut : null,
            market_me_gets: hasMarket ? valueIn : null,
            market_gap_pct: hasMarket ? Math.round(gap * 100) : null,
            notes,
            why_it_works_for_them: `+${round1(theirSide.ros)} ROS lineup pts: ${why}`,
            _score: Math.min(mineSide.ros, theirSide.ros),
          });
        }
      }
    }
  }

  ideas.sort((a, b) => b._score - a._score || b.my_gain_playoffs - a.my_gain_playoffs);
  // At most 2 ideas per partner so the list isn't one team's variations.
  const perPartner = new Map<string, number>();
  const top = ideas.filter((i) => {
    const n = perPartner.get(i.partner) ?? 0;
    perPartner.set(i.partner, n + 1);
    return n < 2;
  });
  return { evaluated_ideas: ideas.length, ideas: top.slice(0, opts.maxResults).map(({ _score, ...i }) => i), market_filter: hasMarket,
    ...(hasMarket ? {} : { warning: "FantasyCalc is unavailable, so these swaps are NOT checked for market fairness and may be lopsided; the other team is unlikely to accept many of them." }),
  };
}
