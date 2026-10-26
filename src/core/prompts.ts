import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function userMessage(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

/** Reusable workflows that show up as prompts/slash commands in Claude clients. */
export function registerPrompts(server: McpServer) {
  server.registerPrompt(
    "waiver_review",
    {
      title: "Waiver wire review",
      description: "Full waiver review for your team: best adds, who to drop, and FAAB bids",
      argsSchema: { username: z.string(), league_id: z.string().optional() },
    },
    ({ username, league_id }) =>
      userMessage(
        `Do a waiver wire review for Sleeper user "${username}"${league_id ? ` in league ${league_id}` : ""}.
1. get_team_context: identify real needs (positional_depth shortfalls, injuries, upcoming byes, weak starters) and the weakest droppable players.
2. get_free_agents for the positions that matter (sort by ros, and also check trending and week if a short-term fill is needed).
3. get_league_landscape: who else needs the same positions, FAAB budgets and recent bid sizes.
4. Web search news for the top candidates: role changes, injuries, expert takes.
Give me the top 3 moves ranked, each with: add, drop, suggested bid or claim priority, and the deciding reasons. Then mention any speculative stash worth considering.`,
      ),
  );

  server.registerPrompt(
    "start_sit",
    {
      title: "Start/sit help",
      description: "Set the best lineup for this week, with reasoning on the close calls",
      argsSchema: { username: z.string(), league_id: z.string().optional() },
    },
    ({ username, league_id }) =>
      userMessage(
        `Help Sleeper user "${username}"${league_id ? ` in league ${league_id}` : ""} set this week's lineup.
1. get_team_context: compare the optimal lineup with the current one, and flag injuries/byes.
2. For close calls (within ~2 projected points) or questionable players, call get_player_report and web search the latest injury/practice news and matchup analysis.
3. Consider the matchup: if I'm a big underdog, lean toward higher-ceiling options; if favored, lean toward safer floors.
Give the lineup changes to make (or confirm no changes), with reasoning only for the close calls.`,
      ),
  );
}
