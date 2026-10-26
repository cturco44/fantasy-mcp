import type { LeagueContext, PlayerRow } from "./league.js";
import { round1 } from "./scoring.js";
import type { Player } from "./sleeper.js";
import { hoursOld, type NewsItem } from "./sources/news.js";

/**
 * Concrete "go web search this" prompts placed in tool results. The server can't
 * search the web itself; these tell Claude exactly where the data runs out.
 */
const MAX_ITEMS = 8;
const QUESTIONABLE = new Set(["Questionable", "Doubtful", "Out", "PUP", "Sus", "IR"]);

export interface DepthAheadEntry {
  name: string;
  depth_chart: string;
  injury: string | null;
}

/** Teammates listed ahead of a player at his depth-chart spot, with injury status. */
export function depthAhead(
  players: Record<string, Player>,
  id: string,
  injuryOf: (id: string) => string | null,
): DepthAheadEntry[] {
  const p = players[id];
  if (!p?.team || !p.depth_chart_position || !p.depth_chart_order) return [];
  return Object.values(players)
    .filter(
      (o) =>
        o.team === p.team &&
        o.id !== id &&
        o.depth_chart_position === p.depth_chart_position &&
        o.depth_chart_order != null &&
        o.depth_chart_order < p.depth_chart_order!,
    )
    .sort((a, b) => a.depth_chart_order! - b.depth_chart_order!)
    .map((o) => ({
      name: o.name,
      depth_chart: `${o.depth_chart_position}${o.depth_chart_order}`,
      injury: injuryOf(o.id),
    }));
}

/** Compact news for tool output: newest first, with age so staleness is obvious. */
export function newsSummary(news: NewsItem[] | undefined, withStory: boolean) {
  if (!news?.length) return undefined;
  return news.map((n) => ({
    age: `${Math.round(hoursOld(n))}h ago`,
    headline: n.headline,
    ...(withStory && n.story ? { story: n.story } : {}),
  }));
}

function searchHint(row: { name: string; team: string | null | undefined }): string {
  return row.team ? `"${row.name} ${row.team}"` : `"${row.name}"`;
}

function recent(news: NewsItem[] | undefined, hours: number): NewsItem | undefined {
  return news?.find((n) => hoursOld(n) <= hours);
}

export class Research {
  private items: string[] = [];
  private seen = new Set<string>();

  constructor(private ctx?: LeagueContext) {}

  private add(key: string, text: string) {
    if (this.seen.has(key) || this.items.length >= MAX_ITEMS) return;
    this.seen.add(key);
    this.items.push(text);
  }

  injury(row: PlayerRow) {
    if (row.injury && QUESTIONABLE.has(row.injury) && !row.opp?.includes("(final)")) {
      this.add(
        `inj:${row.id}`,
        `${row.name} is ${row.injury}. Search ${searchHint(row)} injury/practice news from the last 2 days before deciding (Sleeper status refreshes hourly but lags beat reporters).`,
      );
    }
  }

  /** Experts split: FantasyPros weekly consensus vs ESPN analysts for the same week. */
  disagreement(row: PlayerRow) {
    const fp = row.fp_week;
    const espn = row.espn;
    if (!fp || espn?.analyst_rank_avg == null || fp.week !== espn.rank_week) return;
    // Weekly ranks for a game that already kicked off aren't actionable.
    if (fp.week === this.ctx?.week && row.opp?.includes("(")) return;
    const gap = Math.abs(fp.ecr - espn.analyst_rank_avg);
    if (gap >= Math.max(6, 0.4 * Math.min(fp.ecr, espn.analyst_rank_avg))) {
      this.add(
        `split:${row.id}`,
        `Experts split on ${row.name}: FantasyPros ${fp.rank} (ECR ${fp.ecr}) vs ESPN analysts avg ${row.pos}${round1(espn.analyst_rank_avg)}. Search ${searchHint(row)} analysis to see what's driving the gap.`,
      );
    }
  }

  /** Recent usage well above/below season norms suggests a role change projections may lag. */
  roleChange(row: PlayerRow) {
    const s = row.usage?.season;
    const l = row.usage?.last3;
    if (!s || !l || s.games < 4) return;
    const tgt = (l.target_share ?? 0) - (s.target_share ?? 0);
    const rush = (l.rush_share ?? 0) - (s.rush_share ?? 0);
    if (Math.abs(tgt) >= 7 || Math.abs(rush) >= 15) {
      const what = Math.abs(tgt) >= 7
        ? `target share ${l.target_share}% last 3 vs ${s.target_share}% season`
        : `rush share ${l.rush_share}% last 3 vs ${s.rush_share}% season`;
      this.add(
        `role:${row.id}`,
        `Possible role change for ${row.name}: ${what}. Search ${searchHint(row)} depth chart/usage news.`,
      );
    }
  }

  /** Trending spike with or without an obvious cause. */
  trending(
    row: { id: string; name: string; team: string | null | undefined },
    adds: number,
    ahead: DepthAheadEntry[],
    news: NewsItem[] | undefined,
  ) {
    const hurtAhead = ahead.find((a) => a.injury && QUESTIONABLE.has(a.injury));
    // Trending counts cover ~48h; news from just before that window often explains the spike.
    const fresh = recent(news, 72);
    if (hurtAhead) {
      this.add(
        `trend:${row.id}`,
        `${row.name} (${adds.toLocaleString("en-US")} adds) is behind ${hurtAhead.name} (${hurtAhead.depth_chart}, ${hurtAhead.injury}). Search the latest on ${hurtAhead.name}'s injury timeline to size the opportunity.`,
      );
    } else if (!fresh) {
      this.add(
        `trend:${row.id}`,
        `${row.name}: ${adds.toLocaleString("en-US")} adds but no injury ahead of him on the depth chart and no ESPN news in 72h, so the data doesn't explain it. Web search ${searchHint(row)} for the last 2 days; if nothing turns up, say the cause is unknown rather than guessing.`,
      );
    }
  }

  /** Close lineup decisions: a bench player projected within `margin` of a starter he could replace. */
  closeCalls(lineup: { slot: string; id: string | null; points: number }[], bench: PlayerRow[], eligible: (id: string, slot: string) => boolean, margin = 1.5) {
    for (const b of bench) {
      if (b.opp === "BYE" || (b.injury && ["Out", "IR"].includes(b.injury)) || b.opp?.includes("(")) continue;
      const rival = lineup
        .filter((l) => l.id && eligible(b.id, l.slot) && Math.abs(l.points - b.proj) <= margin)
        .sort((x, y) => x.points - y.points)[0];
      if (rival?.id) {
        const starter = this.ctx?.players[rival.id]?.name ?? rival.id;
        this.add(
          `close:${b.id}:${rival.id}`,
          `Close call at ${rival.slot}: ${starter} (${round1(rival.points)}) vs ${b.name} (${b.proj}). Search matchup and news for both before settling it.`,
        );
      }
    }
  }

  /** Anyone in a trade who is Questionable or worse: the injury timeline decides the value. */
  tradeInjury(row: PlayerRow) {
    if (row.injury && QUESTIONABLE.has(row.injury)) {
      this.add(
        `tinj:${row.id}`,
        `${row.name} is ${row.injury} and is part of this trade. Search ${searchHint(row)} injury timeline (diagnosis, expected return, practice reports) before judging his value; trade values and projections may not price it in.`,
      );
    }
  }

  /** Market value moving fast over 30 days. */
  valueTrend(row: PlayerRow) {
    const t = row.trade_value;
    if (t && t.value >= 500 && Math.abs(t.trend_30d) > 0.1 * t.value) {
      this.add(
        `vtrend:${row.id}`,
        `Market is moving on ${row.name}: trade value ${t.trend_30d > 0 ? "up" : "down"} ${Math.abs(t.trend_30d)} over 30 days (now ${t.value}, ${(100 * Math.abs(t.trend_30d) / t.value).toFixed(0)}% of value). Search ${searchHint(row)} for why (role, injury, schedule); if nothing explains it, say the cause is unknown.`,
      );
    }
  }

  /** FantasyCalc positional rank and FantasyPros ROS positional rank far apart. */
  marketVsProjection(row: PlayerRow) {
    const t = row.trade_value;
    const fpRank = Number(row.fp_ros?.rank?.match(/\d+/)?.[0]);
    if (!t || !fpRank) return;
    const gap = Math.abs(t.pos_rank - fpRank);
    if (gap >= Math.max(6, 0.5 * Math.min(t.pos_rank, fpRank))) {
      this.add(
        `mvp:${row.id}`,
        `Market and experts disagree on ${row.name}: FantasyCalc ${row.pos}${t.pos_rank} vs FantasyPros ROS ${row.fp_ros!.rank}. ${t.pos_rank < fpRank ? "The market values him more than experts do" : "Experts like him more than the market"}; search ${searchHint(row)} recent analysis to see which is right.`,
      );
    }
  }

  /** Trade deadline passed or close. */
  deadline() {
    const week = this.ctx?.week;
    const deadline = this.ctx?.league.settings.trade_deadline;
    if (!week || !deadline || deadline <= 0) return;
    if (week > deadline) {
      this.add("deadline", `The trade deadline (week ${deadline}) has passed; trades can't be processed now.`);
    } else if (deadline - week <= 1) {
      this.add("deadline", `The trade deadline is week ${deadline} (this is week ${week}): propose now, since a counteroffer round may not fit.`);
    }
  }

  staleRankings() {
    if (!this.ctx) return;
    const { fpWeek } = this.ctx.ext;
    if (fpWeek != null && fpWeek !== this.ctx.week) {
      this.add(
        "stale:fp",
        `FantasyPros weekly ranks are still for week ${fpWeek} (they update midweek); weigh projections, rest-of-season ranks and news more for week ${this.ctx.week}.`,
      );
    }
  }

  result(): string[] | undefined {
    return this.items.length ? this.items : undefined;
  }
}
