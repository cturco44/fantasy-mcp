# 🏈 fantasy-mcp

**A roster-aware fantasy football assistant for Claude, built for Sleeper leagues.**

Rankings tell you who's good. They don't tell you who's good *for your team*. A rankings list
can't see that you already have three tight ends, that your kicker's bye leaves you with nobody,
that you're 9th in waiver priority, or that the guy everyone is adding has no obvious reason for
the hype.

fantasy-mcp gives Claude what it needs to reason about those things: your league, your roster,
your scoring, consensus expert rankings, usage data, news, and specific prompts telling it what to
web-search before it answers.

---

## ✨ What it can do

Ask Claude questions like you'd ask a friend who follows fantasy closely:

| You ask | What it does |
|---|---|
| 🔄 *"Do a waiver review for my team."* | Finds your weak spots, checks who's actually available in **your** league, compares rankings, projections and usage, checks who else in your league needs the same position, searches the latest news, and gives you ranked moves with **who to drop** for each. |
| 🪑 *"Who should be in my flex this week?"* | Compares your best projected lineup with the one you've set, flags injuries and byes, and researches the close calls. |
| 📈 *"Why is everyone adding this guy?"* | Checks the depth chart (is the starter ahead of him hurt?), recent news, and usage trends. If nothing explains the spike, it searches the web, and if it still can't find a reason it says so instead of guessing. |
| 🏥 *"What's the latest on my injured WR?"* | Pulls timestamped news, then searches for practice reports and beat-reporter updates newer than the official designation. |
| 🤔 *"Is the top-ranked TE actually better for my team?"* | Puts FantasyPros, ESPN analysts, projections and usage side by side and explains the tie-breaker for your roster. |
| 🗺️ *"Which teams in my league need a RB?"* | Ranks every team's strength by position and shows waiver order and FAAB budgets, so you know who you're competing with for a pickup. |

### 🧠 Built around your roster, not just rankings

- **Positional depth:** starters needed vs. rostered at each position, so it won't push a 4th TE
  unless he's a real upgrade over someone you'd drop.
- **Bye and injury gaps:** flags weeks where you can't field a full lineup ("no kicker in Week 8").
- **Your league's scoring:** projections are recalculated with your league's exact scoring (TE
  premium, bonuses, 6-point passing TDs), not generic PPR numbers.
- **Time horizon:** weighs this week, the rest of the season, and **your fantasy playoff weeks**,
  adjusted for your record. A contender and a 1-5 team need different moves.
- **Every add names a drop.**

---

## 🔎 How the deep research works

This is the main thing that sets it apart. Answering a question takes three layers:

```
┌──────────────────────────────────────────────────────────────────┐
│ 1. 📊 DATA: the server merges 6 sources into each player          │
│    Sleeper league data · projections · FantasyPros consensus ·    │
│    ESPN analysts · usage data · timestamped news                  │
├──────────────────────────────────────────────────────────────────┤
│ 2. 🚩 FLAGS: the server checks the data for gaps and conflicts    │
│    and lists specific searches in `research_needed`               │
├──────────────────────────────────────────────────────────────────┤
│ 3. 🌐 WEB SEARCH: Claude runs those searches (plus news for every │
│    player it recommends), then weighs everything and answers      │
└──────────────────────────────────────────────────────────────────┘
```

### Why web search matters

Data feeds are always behind real life. Injury designations lag beat reporters by hours. Usage
stats update overnight. Expert rankings for next week aren't published until midweek. And no
data feed explains **why** something happened: why a backup got 11 carries, why a WR is suddenly
trending, why experts are split on a player.

So the server doesn't pretend to know. It tells Claude **exactly what it doesn't know**, and
Claude goes and finds out.

### 🚩 What triggers a research flag

The server adds a `research_needed` list to each tool result. These are concrete searches,
generated when it spots:

| Signal | Example flag |
|---|---|
| 📈 **Unexplained trending spike** | *"1,089,992 adds but no injury ahead of him on the depth chart and no ESPN news in 72h, so the data doesn't explain it. Web search 'Player IND' for the last 2 days; if nothing turns up, say the cause is unknown rather than guessing."* |
| 🔗 **Explained trending spike** | *"Backup RB (231,413 adds) is behind his starter (RB1, Questionable). Search the latest on the starter's injury timeline to size the opportunity."* |
| 🏥 **Injury designation** | *"WR is Out. Search injury/practice news from the last 2 days (Sleeper status lags beat reporters)."* |
| 📊 **Role change** | *"Possible role change: target share 23.6% last 3 games vs 16.5% season. Search depth chart/usage news."* |
| ⚔️ **Experts disagree** | *"Experts split: FantasyPros K6 vs ESPN analysts avg K31. Search for what's driving the gap."* |
| 🪙 **Close lineup call** | *"Close call at FLEX: Player A (11.5) vs Player B (10.3). Search matchup and news for both."* |
| ⏰ **Stale rankings** | *"FantasyPros weekly ranks are still for last week; weigh projections, rest-of-season ranks and news more."* |

Claude is instructed to **run every flagged search**, web-search recent news for every player it
recommends, **cite sources with dates**, and **never invent a cause**. If the data and the web
can't explain something, it says "unknown." That last rule matters: a confident wrong reason is
worse than an honest "I don't know."

### ⚖️ Sources are compared, not just ranked

Each player row puts several viewpoints side by side, and **disagreement between them** is what
tells Claude where to dig:

- 📐 **Projections** (Rotowire, scored for your league): what the model expects
- 🧑‍🏫 **FantasyPros consensus** (ECR from 100+ experts, with spread and best/worst rank): what experts think, and how much they disagree
- 📺 **ESPN analysts** (average of ~8 analysts) plus ESPN rostered % and its weekly change: a second expert panel and the market's reaction
- 🔬 **Usage** (nflverse play-by-play): target share, air-yards share, rush share, and **expected fantasy points**. A player scoring well above his expected points is probably riding touchdowns that won't last; one with solid expected points and poor results is a buy-low.
- 🔥 **Trending adds** across Sleeper: what other managers are reacting to
- 📰 **News** with timestamps: the latest ESPN blurbs, labeled with their age

---

## 🛠️ Tools

| Tool | What it returns |
|---|---|
| `find_user_leagues` | A Sleeper user's leagues and their team in each (works with any number of teams) |
| `get_team_context` | League settings, record and standing, matchup, full roster with all data sources, best lineup vs. current lineup, positional depth, research flags |
| `get_free_agents` | Players actually available in the league, sortable by projections, FantasyPros rank, trending, ESPN rostered-% movers, and more, plus your depth at those positions |
| `get_player_report` | Deep view of 1–5 players: league-scored game log (snaps, targets, carries, target share, expected points), next 4 matchups, news with story text, ESPN outlook, depth chart |
| `get_league_landscape` | Every team's strength by position, waiver order or FAAB, and recent transactions with bids |
| `get_rankings` | FantasyPros consensus for a position next to ESPN ranks and league projections, with who rosters each player |
| `get_trending_players` | Sleeper-wide trending adds/drops, with depth-chart context, latest news, and availability in your league |

Two **prompts** run full workflows from Claude's prompt menu:
- `waiver_review`: the full waiver workflow, ending in ranked add/drop/bid recommendations
- `start_sit`: best lineup this week, with research on the close calls

All tools are **read-only**. It recommends; you make the moves in Sleeper.

---

## 🚀 Setup

### 1. Install

You need **Node.js 20+** (`node -v` to check). If you need to install or upgrade it, an easy way is
[fnm](https://github.com/Schniz/fnm): `fnm install --lts`.

```sh
git clone <this repo>
cd fantasy-mcp
npm install
```

### 2. Connect it to Claude

#### 🖥️ Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) and add a
`mcpServers` entry. **Use absolute paths.** Claude Desktop doesn't load your shell's `PATH`, so it
needs the full path to `node`. Get it with `which node`.

```json
{
  "mcpServers": {
    "fantasy": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/fantasy-mcp/node_modules/tsx/dist/cli.mjs",
        "/absolute/path/to/fantasy-mcp/src/adapters/stdio.ts"
      ]
    }
  }
}
```

If the file already has other settings, add `mcpServers` alongside them, then **fully quit and
reopen** Claude Desktop (Cmd+Q). You should see **fantasy** in the chat's tools menu.

> 💡 Claude Desktop only loads server code at startup. After pulling updates, restart it.

#### ⌨️ Claude Code

Copy the template and fill in your absolute paths (same as above):

```sh
cp .mcp.example.json .mcp.json   # .mcp.json is git-ignored, so your local paths stay local
```

Then start Claude Code in this folder and approve the `fantasy` server.

#### 🔧 Poking at it directly

```sh
npm run dev       # HTTP server at http://localhost:8787/mcp
npm run inspect   # MCP Inspector UI: call tools by hand and see raw output
```

### 3. 🎯 Set up a Claude Project (recommended)

A Claude Project gives every chat the same standing instructions, so you don't repeat your username
or the research rules each time. Your own instructions also carry more weight with Claude than a
server's, which is what makes the research reliable.

In Claude Desktop: **Projects → New Project**, then fill in:

**What are you trying to achieve?** (the description)

> Win my Sleeper fantasy football leagues with roster-aware advice on waivers, start/sit, and
> drops. Recommendations should fit my actual roster and league, not just rankings, and be backed
> by current news and expert opinion.

**Instructions:**

> My Sleeper username is `YOUR_USERNAME`; my main team is in `YOUR_LEAGUE_NAME`.
>
> Use the **fantasy** MCP server (get_team_context, get_free_agents, get_player_report,
> get_trending_players, etc.) plus web search. Do not use other fantasy connectors in this
> project.
>
> Before any fantasy recommendation, web search the latest news (last 48 hours) for every player
> you recommend or compare, and run every search listed in `research_needed`. Cite sources and
> dates. If you can't find why something happened, say so; don't guess.

Then, in each chat:
- ✅ Make sure **web search is turned on** in the tools menu. The research loop depends on it.
- ✅ Make sure the **fantasy** server is enabled.
- ⚠️ **Turn off other fantasy connectors** (e.g. FantasyPros) in this Project's chats. Some ship
  instructions telling Claude to treat their rankings as final and *not* web search, which works
  directly against the research loop. You can keep using them in other chats.

---

## 💬 Prompts to try

- *"What leagues do I have and how's my team looking?"*
- *"Who's on bye next week, and what should I do about it?"*
- *"Do a waiver review. Top 3 moves with who to drop."*
- *"Should I pick up another wide receiver?"* (it should push back if you're already deep)
- *"Why is [trending player] being added so much? Should I grab him?"*
- *"Who's the best TE available, and is he actually better than mine for my team?"*
- *"Who should be in my flex spots this week?"*
- *"Which teams in my league need a RB, and how does that affect who I target?"*
- *"How current is the data you're using right now?"*

---

## 🏗️ How it's built

```
src/
  core/                 host-agnostic logic (runs anywhere)
    sleeper.ts          Sleeper API client (leagues, rosters, projections, stats, schedule)
    league.ts           joins everything into player rows, lineups, depth, context
    scoring.ts          league-specific scoring, roster slot eligibility, best-lineup logic
    research.ts         research_needed flags + depth-chart context
    tools.ts            MCP tool definitions
    prompts.ts          waiver_review / start_sit workflows
    instructions.ts     how Claude should reason (sent to Claude on connect)
    sources/
      fantasypros.ts    FantasyPros consensus (via DynastyProcess)
      espn.ts           ESPN analyst ranks, rostered %, outlooks
      nflverse.ts       usage + expected fantasy points
      news.ts           ESPN player news
      ids.ts            cross-site player ID matching
  storage/              cache backends (local files now; Cloudflare KV later)
  adapters/             entry points: stdio (Claude Desktop/Code), HTTP (node)
```

**Design choices:**
- 🧩 **The server supplies data and flags; Claude decides.** No hardcoded "start/sit" rules. The
  server gathers context and points out what's unclear, and Claude does the reasoning, which is
  what it's good at.
- 🛡️ **Each source is isolated.** If ESPN or FantasyPros goes down, tools still answer, and
  `data_as_of` lists what's missing.
- ⏱️ **Everything is labeled with how fresh it is.** Each response says what week each source covers
  and how old it is, so Claude can tell when something is stale.
- 🔗 **Players are matched across sources** using the DynastyProcess ID crosswalk, with a
  name + team fallback for players it doesn't cover yet (mostly rookies and kickers).
- 🌍 **Portable.** Built on web-standard APIs and [Hono](https://hono.dev), so the same code can
  be deployed to Cloudflare Workers (or elsewhere) later.

### 📡 Data sources and refresh rates

| Source | What | Cache |
|---|---|---|
| [Sleeper API](https://docs.sleeper.com) | Leagues, rosters, matchups, transactions, players, trending | 2–5 min (live) |
| Sleeper projections/stats/schedule | Rotowire projections, box scores (live during games), byes, game status | 10 min – 6 h |
| [DynastyProcess](https://github.com/dynastyprocess/data) | FantasyPros consensus (weekly + rest-of-season), player ID crosswalk | 3 h (updated ~2× daily upstream) |
| ESPN fantasy API | Analyst ranks, rostered %, weekly outlooks | 3 h |
| ESPN player news | Timestamped news blurbs | 30 min |
| [ffopportunity](https://github.com/ffverse/ffopportunity) / [nflverse](https://github.com/nflverse) | Expected vs. actual fantasy points, target/air-yard/rush share | 6 h (nightly upstream) |

Cached responses live in `.cache/`. Delete it to force a full refresh.

---

## ⚠️ Limitations

- **Runs on your computer.** For now it only works in Claude Desktop or Claude Code on the machine
  running it. Phone support needs a hosted deployment (planned).
- **Sleeper only**, and NFL redraft is the main focus. Dynasty and keeper leagues work, but the
  advice isn't tuned for them yet.
- **FantasyPros ranks are PPR** for skill positions. Half-PPR and standard leagues get a note
  saying so.
- **Some endpoints are unofficial** (Sleeper projections, ESPN). They're widely used but could
  change without notice. Each is isolated, so a breakage loses one source, not the tool.
- **Read-only.** It can't make moves in Sleeper.
- Data comes from free public sources, for **personal, non-commercial use**. Please respect each
  source's terms.

## 🗺️ Roadmap

- ☁️ Deploy to Cloudflare Workers with Google login, so it works on your phone and stays private
- 🤝 Trade analysis (FantasyCalc trade values plus league needs → trade partner suggestions)
- 🎰 Vegas implied team totals for weekly start/sit

---

Built with [Claude](https://claude.ai) and the
[Model Context Protocol](https://modelcontextprotocol.io). Good luck this week. 🏆
