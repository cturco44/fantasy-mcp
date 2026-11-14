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
| 🤝 *"Is this trade fair: my X for their Y?"* | Computes each team's change in projected starting-lineup points for the rest of the season and your fantasy playoffs (bye overlaps and positional need included), FantasyCalc market value, roster-limit drops, and whether the other team would actually benefit, then researches every player in the deal. |
| 🔎 *"Find me a trade for a TE."* | Searches every other team for win-win swaps where both lineups improve and market values are within ~20%, with a note on why each works for them. |
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
│ 1. 📊 DATA: the server merges 7 sources into each player          │
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
| 🤝 **Trade injury** | *"Player is Questionable and part of this trade. Search his injury timeline before judging his value."* |
| 💹 **Market moving** | *"Trade value down 1668 over 30 days. Search for why; if nothing explains it, say the cause is unknown."* |
| 🆚 **Market vs experts** | *"FantasyCalc RB15 vs FantasyPros ROS RB30. Search recent analysis to see which is right."* |
| 📅 **Trade deadline** | *"The trade deadline is week 11 (this is week 10): propose now."* |
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
| `evaluate_trade` | A proposed trade from both sides: rest-of-season and playoff lineup-point change, FantasyCalc market value in/out, forced roster-limit drops or open bench spot, new positional holes, trade deadline, research flags |
| `find_trade_partners` | Win-win 1-for-1, 2-for-1 and 1-for-2 swaps across the league (both lineups improve, market values within ~20%), ranked, with why each works for the other team |
| `get_trade_values` | FantasyCalc value, rank and 30-day trend next to FantasyPros ROS rank and ROS projection, for named players or the top of a position |

Three **prompts** run full workflows from Claude's prompt menu:
- `waiver_review`: the full waiver workflow, ending in ranked add/drop/bid recommendations
- `start_sit`: best lineup this week, with research on the close calls
- `trade_review`: evaluate a trade (or find one) and recommend accept, decline or counter

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

### 2. Run it locally (Claude Desktop / Claude Code)

Skip this if you only want the hosted version (see *Deploying to Cloud Run* below).
> 💡 If you use **both** a local and a hosted server, name the local entry `fantasy-local` (instead of
> `fantasy` below) so the two don't clash, and keep the hosted connector named `fantasy`.

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

### 3. 🎯 Set up a Claude Project (strongly recommended)

A Claude Project gives every chat the same standing instructions, so you don't repeat your username
or the research rules each time. Your own instructions also carry more weight with Claude than a
server's, which is what makes the web research reliable.

**This server is built to be used with heavy web research.** Rankings, projections and expert
consensus are one input, and they lag real life. The setup below tells Claude to search the web for
every player it recommends instead of leaning on any single ranking source.

In Claude (web, desktop or phone): **Projects → New Project**, then fill in:

**What are you trying to achieve?** (the description)

> Win my Sleeper fantasy football leagues with roster-aware advice on waivers, start/sit, trades
> and drops. Recommendations should fit my actual roster and league, not just rankings, and be backed
> by current news and expert opinion.

**Instructions** (replace the placeholders):

> My Sleeper username is `YOUR_USERNAME`; my main team is in `YOUR_LEAGUE_NAME`.
>
> Before any fantasy recommendation, web search the latest news (last 48 hours) for every player you
> recommend or compare, and run every search listed in `research_needed`. Cite sources and dates.
> If you can't find why something happened, say so; don't guess.
>
> Do not use the FantasyPros connector for this. Strictly use the **fantasy** MCP server (the hosted
> one, not `fantasy-local`). Use only those tools plus web search.

Why each line is there:
- **The research rule** makes web search a required step, not an optional extra, and "cite sources and
  dates" keeps the answers checkable.
- **"Do not use the FantasyPros connector"**: some connectors ship instructions telling Claude to
  treat their rankings as final and *not* web search, which works directly against the research loop.
- **"The hosted one, not `fantasy-local`"** avoids Claude picking the wrong server if you have both
  enabled. You can leave this out if you only run one.

Then, in each chat:
- ✅ Make sure **web search is turned on** in the tools menu. The research loop depends on it.
- ✅ Make sure the **fantasy** connector is enabled (and `fantasy-local` and any other fantasy
  connectors are off).

---

## ☁️ Deploying to Cloud Run

Run it as a **private remote server** so it works from claude.ai on the web and your phone, for about
**$0/month** (inside Cloud Run's always-free tier). Only the Google accounts you allow can use it.

**Pieces**
- **Cloud Run**, scaled to zero. The first request after idle takes a few seconds (a cold start).
- **Cloud Storage** holds the cache, so it survives cold starts. Hot reads come from memory.
- **Its own OAuth 2.1 layer** (`src/auth/`): Google sign-in for identity, an email allowlist, and
  stateless signed JWTs (no token database). This is what claude.ai's custom connector speaks.
- **Secret Manager** for `JWT_SECRET` and the Google client secret.
- **GitHub Actions** deploys on every push to `main`.

### Who can use it

Three gates, so knowing the URL isn't enough:
1. The Google OAuth consent screen is in **Testing** mode: only accounts you add as test users can
   even attempt to sign in.
2. After sign-in, the verified email must be in **`ALLOWED_EMAILS`**, or no token is issued.
3. Every call to `/mcp` needs a valid Bearer token for an allowlisted user.

The allowlist is re-checked on every request and every token refresh, so removing an email cuts that
person off immediately. Rotating `JWT_SECRET` signs everyone out. Only `/` (a health text) and the
OAuth routes are public.

### Environment variables

| Variable | Required | Notes |
|---|---|---|
| `CACHE_BUCKET` | yes (on Cloud Run) | Cloud Storage bucket for the cache |
| `PUBLIC_URL` | yes | Public base URL of the service, no trailing slash |
| `GOOGLE_CLIENT_ID` | yes | From your Google OAuth client |
| `GOOGLE_CLIENT_SECRET` | yes | Keep in Secret Manager |
| `JWT_SECRET` | yes | 32+ characters, e.g. `openssl rand -base64 48`. Keep in Secret Manager |
| `ALLOWED_EMAILS` | yes | Comma-separated, compared lowercase |
| `AUTH_DISABLED` | local only | `1` skips auth for local testing. **Refused on Cloud Run.** |
| `PORT` | no | Defaults to 8080 |

The server exits at startup if a required variable is missing.

### One-time setup

You need the [gcloud CLI](https://cloud.google.com/sdk/docs/install) and a Google Cloud billing account.

1. **Create a dedicated project** (nothing else in it) and link billing. A free-trial billing account
   is the safest: Google never charges the card, and resources just stop when the credit runs out.
   Don't click "Activate full account" until you've decided to keep running after the trial.
2. **Set up the cost protection below** before deploying anything.
3. **Enable APIs**: `run`, `cloudbuild`, `artifactregistry`, `storage`, `secretmanager`.
4. **Create a bucket** in `us-central1`, and a dedicated runtime service account with
   `roles/storage.objectAdmin` on that bucket only.
5. **Create a Google OAuth client** (Console → Google Auth Platform): audience **External**, status
   **Testing**, your emails as **test users**; client type **Web application** with the redirect URI
   `<SERVICE_URL>/oauth/google/callback` (add `http://localhost:8080/oauth/google/callback` to test
   locally).
6. **Store the two secrets** in Secret Manager and let the runtime service account read them.
7. **Deploy** (set the real values; `PUBLIC_URL` is `https://<service>-<project-number>.<region>.run.app`):
   ```sh
   gcloud run deploy fantasy-mcp --source . --region us-central1 --service-account <RUNTIME_SA> \
     --allow-unauthenticated --min-instances 0 --max-instances 1 --concurrency 20 --timeout 60 \
     --memory 512Mi --cpu 1 --cpu-throttling \
     --set-env-vars CACHE_BUCKET=...,PUBLIC_URL=...,GOOGLE_CLIENT_ID=...,ALLOWED_EMAILS=... \
     --set-secrets JWT_SECRET=jwt-secret:latest,GOOGLE_CLIENT_SECRET=google-client-secret:latest
   ```
   `--allow-unauthenticated` is intentional: Google's IAM gate would block claude.ai, so the OAuth
   layer is the gate. After this first deploy, `npm run deploy` repeats it (env vars and secrets
   persist on the service).
8. **Connect Claude**: claude.ai → Settings → Connectors → **Add custom connector** → URL
   `<SERVICE_URL>/mcp` → Connect → sign in with Google. On the "Google hasn't verified this app"
   screen (normal in Testing mode for your own app), choose Advanced → continue. Connectors added on
   the web sync to the mobile app.

### 💸 Cost protection

Google budgets only *alert*; they don't stop spending. So this uses layers:

1. **Dedicated project**, so a kill switch can't take anything else down.
2. **Free-trial billing account** (see above).
3. **Hard caps on the service**: max 1 instance, concurrency 20, 60 s timeout, 512Mi, 1 CPU,
   min 0, CPU only billed during requests.
4. **Budget alerts**: a $5 budget scoped to the project, with alerts at 20%, 50%, 90%, 100% and a
   100% forecast.
5. **Automatic kill switch**: the budget publishes to a Pub/Sub topic that triggers
   [`infra/billing-guard`](infra/billing-guard/), a tiny private Cloud Run service that **disables
   billing on the project** when actual cost reaches the budget. If it fires, the server goes offline
   until you re-link billing. It has a `DRY_RUN=1` mode that only logs.
6. **Cleanup policies**: Artifact Registry keeps the 2 newest images and source-upload buckets expire
   objects after 7 days.

### 🔄 CI/CD

`.github/workflows/deploy.yml` runs on **pushes to `main` only** (never on pull requests: this repo is
public, and forks must not reach your cloud). It type-checks and runs the tests, deploys, then
smoke-tests (`GET /` returns 200 and an unauthenticated `POST /mcp` returns 401).

- **No keys**: it authenticates with **Workload Identity Federation**, and the provider only accepts
  tokens from this repo's `main` branch.
- **Least privilege**: a dedicated deployer service account with narrowly scoped roles.
- **Config stays on the service**: secrets and env vars are never in the workflow. The repo holds only
  three non-secret variables: `GCP_PROJECT_ID`, `GCP_WIF_PROVIDER` and `GCP_DEPLOYER_SA`.
- Docs-only pushes (`*.md`, `docs/`) don't trigger a deploy.

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
- *"Is this trade fair: my Josh Jacobs for their Bucky Irving?"*
- *"Find me a trade for a TE."*
- *"What's Saquon worth on the trade market, and why has it dropped?"*
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
    trades.ts           rest-of-season lineup value, trade evaluation, trade partner search
    prompts.ts          waiver_review / start_sit / trade_review workflows
    instructions.ts     how Claude should reason (sent to Claude on connect)
    sources/
      fantasypros.ts    FantasyPros consensus (via DynastyProcess)
      espn.ts           ESPN analyst ranks, rostered %, outlooks
      nflverse.ts       usage + expected fantasy points
      news.ts           ESPN player news
      fantasycalc.ts    trade market values
      ids.ts            cross-site player ID matching
  storage/              cache backends: memory, local files (dev), Cloud Storage (hosted)
  auth/                 OAuth 2.1 server for the hosted version: Google sign-in, allowlist, JWTs
  adapters/             entry points: stdio (Claude Desktop/Code), HTTP (local), Cloud Run
test/                   auth flow tests (`npm test`)
infra/billing-guard/    kill switch that disables billing when the budget is hit
.github/workflows/      deploy on push to main
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
- 🌍 **Portable.** Built on web-standard APIs and [Hono](https://hono.dev). Each host is a small
  adapter plus a storage backend, so the core isn't tied to Cloud Run.

### 📡 Data sources and refresh rates

| Source | What | Cache |
|---|---|---|
| [Sleeper API](https://docs.sleeper.com) | Leagues, rosters, matchups, transactions, players, trending | 2–5 min (live) |
| Sleeper projections/stats/schedule | Rotowire projections, box scores (live during games), byes, game status | 10 min – 6 h |
| [DynastyProcess](https://github.com/dynastyprocess/data) | FantasyPros consensus (weekly + rest-of-season), player ID crosswalk | 3 h (updated ~2× daily upstream) |
| ESPN fantasy API | Analyst ranks, rostered %, weekly outlooks | 3 h |
| ESPN player news | Timestamped news blurbs | 30 min |
| [FantasyCalc](https://fantasycalc.com) | Redraft trade values from real trades (matched to your league's size, QBs and PPR) | 6 h |
| [ffopportunity](https://github.com/ffverse/ffopportunity) / [nflverse](https://github.com/nflverse) | Expected vs. actual fantasy points, target/air-yard/rush share | 6 h (nightly upstream) |

Locally, cached responses live in `.cache/` (delete it to force a full refresh). On Cloud Run they live
in the Cloud Storage bucket.

---

## ⚠️ Limitations

- **Hosted cold starts.** On Cloud Run the first request after idle takes a few seconds while the
  instance starts and the cache reloads. It runs one small instance by design to cap cost.
- **Private by design.** The hosted version is for you and the people you allow, not a public service.
  Anyone you add shares one cache and one cost cap.
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

- 🎰 Vegas implied team totals for weekly start/sit

---

Built with [Claude](https://claude.ai) and the
[Model Context Protocol](https://modelcontextprotocol.io). Good luck this week. 🏆
