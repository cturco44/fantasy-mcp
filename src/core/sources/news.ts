import { Cache, MINUTE } from "../cache.js";
import type { Player } from "../sleeper.js";
import { loadIdMaps, type IdMaps } from "./ids.js";

// ESPN fantasy player news (blurbs usually posted within hours of games/practice reports).
// The endpoint only accepts one playerId per request, so fetch just the players we show.
const URL = (espnId: string, limit: number) =>
  `https://site.api.espn.com/apis/fantasy/v2/games/ffl/news/players?limit=${limit}&playerId=${espnId}`;

export interface NewsItem {
  published: string;
  headline: string;
  story?: string;
}

const MAX_CONCURRENT = 8;

function clean(html: string | undefined, max: number): string | undefined {
  if (!html) return undefined;
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

const reverseEspn = new WeakMap<IdMaps, Map<string, string>>();

function espnIdFor(ids: IdMaps, player: Player | undefined, sleeperId: string): string | undefined {
  if (player?.espn_id) return player.espn_id;
  let rev = reverseEspn.get(ids);
  if (!rev) {
    rev = new Map(Object.entries(ids.espn).map(([espn, sleeper]) => [sleeper, espn]));
    reverseEspn.set(ids, rev);
  }
  return rev.get(sleeperId);
}

async function playerNews(cache: Cache, espnId: string, limit: number): Promise<NewsItem[]> {
  return cache.get(`espn:news:${espnId}:${limit}`, 30 * MINUTE, async () => {
    const res = await fetch(URL(espnId, limit), { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`ESPN news request failed (${res.status})`);
    const body = (await res.json()) as { feed?: any[] };
    return (body.feed ?? [])
      .filter((x) => x.headline && x.published)
      .map((x) => ({ published: x.published, headline: clean(x.headline, 300)!, story: clean(x.story, 500) }));
  });
}

/** Latest news per Sleeper player id. Players without an ESPN id or with a failed fetch are omitted. */
export async function loadNews(
  cache: Cache,
  players: Record<string, Player>,
  sleeperIds: string[],
  limit = 3,
): Promise<Record<string, NewsItem[]>> {
  const ids = await loadIdMaps(cache).catch(() => ({ fantasypros: {}, gsis: {}, espn: {} }) as IdMaps);
  const queue = [...new Set(sleeperIds)];
  const out: Record<string, NewsItem[]> = {};

  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const espnId = espnIdFor(ids, players[id], id);
      // Team defenses don't have player news.
      if (!espnId || players[id]?.position === "DEF") continue;
      try {
        out[id] = await playerNews(cache, espnId, limit);
      } catch {
        // One player's news failing shouldn't fail the tool call.
      }
    }
  };
  await Promise.all(Array.from({ length: MAX_CONCURRENT }, worker));
  return out;
}

/** Hours since a news item was published. */
export function hoursOld(item: NewsItem, now = Date.now()): number {
  return (now - Date.parse(item.published)) / 3_600_000;
}
