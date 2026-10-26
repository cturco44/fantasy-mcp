import type { Stats } from "./sleeper.js";

/**
 * Sleeper scoring_settings keys match its stat keys (rec, rec_yd, bonus_rec_te,
 * pts_allow_14_20, ...), so league-specific points are a dot product. This picks
 * up TE premium, bonuses, 6pt passing TDs, etc. that generic PPR numbers miss.
 */
export function scorePoints(stats: Stats | undefined, scoring: Record<string, number>): number {
  if (!stats) return 0;
  let pts = 0;
  for (const [key, weight] of Object.entries(scoring)) {
    const v = stats[key];
    if (v) pts += v * weight;
  }
  return pts;
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Which player positions can fill each Sleeper roster slot. */
export const SLOT_ELIGIBILITY: Record<string, string[]> = {
  QB: ["QB"],
  RB: ["RB"],
  WR: ["WR"],
  TE: ["TE"],
  K: ["K"],
  DEF: ["DEF"],
  DL: ["DL"],
  LB: ["LB"],
  DB: ["DB"],
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  IDP_FLEX: ["DL", "LB", "DB"],
};

export const NON_STARTING_SLOTS = new Set(["BN", "IR", "TAXI"]);

export function startingSlots(rosterPositions: string[]): string[] {
  return rosterPositions.filter((s) => !NON_STARTING_SLOTS.has(s));
}

/** Positions that matter in this league (skips K/DEF/IDP if the league doesn't use them). */
export function leaguePositions(rosterPositions: string[]): string[] {
  const set = new Set<string>();
  for (const slot of startingSlots(rosterPositions)) {
    for (const p of SLOT_ELIGIBILITY[slot] ?? []) set.add(p);
  }
  return [...set];
}

export interface LineupCandidate {
  id: string;
  positions: string[];
  points: number;
  unavailable?: boolean;
}

/**
 * Best lineup by projected points: fill the most restrictive slots first, then
 * flex slots. Greedy is optimal enough for standard Sleeper slot structures.
 */
export function optimalLineup(slots: string[], players: LineupCandidate[]) {
  const ordered = [...slots].sort(
    (a, b) => (SLOT_ELIGIBILITY[a]?.length ?? 99) - (SLOT_ELIGIBILITY[b]?.length ?? 99),
  );
  const pool = players
    .filter((p) => !p.unavailable)
    .sort((a, b) => b.points - a.points);
  const used = new Set<string>();
  const lineup: { slot: string; id: string | null; points: number }[] = [];
  for (const slot of ordered) {
    const eligible = SLOT_ELIGIBILITY[slot] ?? [];
    const pick = pool.find((p) => !used.has(p.id) && p.positions.some((pos) => eligible.includes(pos)));
    if (pick) used.add(pick.id);
    lineup.push({ slot, id: pick?.id ?? null, points: pick?.points ?? 0 });
  }
  return { lineup, total: lineup.reduce((s, l) => s + l.points, 0), starterIds: used };
}
