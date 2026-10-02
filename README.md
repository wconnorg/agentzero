# Agent Zero

ZeroCorps' only Discord bot, for one server. It does three things:

1. **Verify, welcome and goodbye.** It posts a verify message in the verify channel;
   reacting with ✅ gives Verified, and removing the ✅ takes it away again. It posts
   "Welcome @user!" in the welcome channel when someone joins, and "Seeya @user!" in the
   goodbye channel when someone leaves, is kicked or is banned. This is the bot's own
   business: the website never touches it.
2. **Rank roles, from zerocorps.org.** On start and every few minutes it reads every linked
   member's rank from the website and gives the role for it. **A linked member never loses a
   rank role**: only unlinking Discord on the website takes Rookie away (an unlinked member
   drops out of the website's list). When someone joins, it asks the website about them and
   gives their rank role straight away.
3. **Optionally, "Academy Users: N":** a channel named after how many Discord accounts are
   linked on the website.

The website is the source of truth for ranks. The bot stores nothing on disk and keeps
nothing but Discord ids in memory. The contract with the website is
[docs/INTERNAL-API.md](https://github.com/wconnorg/zerocorps/blob/main/docs/INTERNAL-API.md)
in the website's repository.

## Setting it up

### 1. Discord developer portal (Agent Zero's own application)

- **Bot tab:** copy the token (it goes in `.env` only). Switch **Public Bot** off, and
  switch **Server Members Intent** on (the bot needs it for joins). Message Content and
  Presence stay off.
- **Invite it:** OAuth2, URL Generator, scope `bot`, or open this link with the
  application's id in place of `APP_ID`:
  `https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot&permissions=268504128`
  (Manage Roles, View Channels, Send Messages, Read Message History, Add Reactions).

### 2. The server

- **Role order:** in Server Settings, Roles, drag Agent Zero's role **above Verified and
  Rookie**. A bot can only give roles below its own.
- **The verify channel** (`VERIFY_CHANNEL_ID`) holds the verify message and nothing else.
  Everyone can see it and read its history, **Verified included** (they need it to remove
  their ✅), but only the bot posts there. Deny Add Reactions too: members can still click
  the bot's ✅, but cannot add others. The bot needs View Channel, Send Messages, Read
  Message History and Add Reactions there. It never pins anything: it finds its verify
  message again by its own ✅, so leave that ✅ in place.
- **The welcome and goodbye channels** (`WELCOME_CHANNEL_ID`, `GOODBYE_CHANNEL_ID`, both
  optional): the bot needs View Channel and Send Messages in each. Neither may be the verify
  channel.
- **The verified-only channels:** on each one (or on its category), deny View Channel to
  @everyone and allow it to Verified. Then losing Verified hides them again by itself; the
  bot only gives and takes the role. Ranked channels work the same way with Rookie.
- **Academy Users (optional):** make a channel (a voice channel members cannot join works
  well), allow the bot **Manage Channels on that channel only**, and put its id in
  `STATS_CHANNEL_ID`. The bot renames it to "Academy Users: N" at most every five minutes.

### 3. The website (Vercel)

- `INTERNAL_API_SECRET` set in the project's environment for Production (at least 32
  characters), then a redeploy (Deployments, then Redeploy): Vercel only picks up a changed
  value in a new deployment. The bot's `.env` holds the same value. Vercel does not show a
  sensitive value again, so if it is lost, make a new one: `npm run secret:new` writes it
  into `.env` and onto the clipboard without showing it; paste it over Vercel's value and
  redeploy.
- Vercel's Firewall must let the bot through: if the bot logs "Vercel's firewall blocked
  the bot (403 Security Checkpoint)", switch off the challenge on automated requests, or add
  a rule letting `/api/internal/` through.

### 4. `.env`

Copy `.env.example` to `.env` and fill it in. For ids, turn on Developer Mode in Discord
(User Settings, Advanced) and right-click a server, role or channel, then "Copy ID".
`.env` is never committed, and the token and the secret are never printed or logged.

## Running it

Needs Node 24 or later.

```sh
npm install
npm start
```

Stop it with Ctrl+C. `npm run check` runs the type check and the tests.

The log is one line per event. On a good start you see it sign in, "verify message ready",
which greetings are on and in which channels, and a first `rank sync:` line; after that,
only role changes and problems.

**The bot is online only while it is running.** Close the terminal, or let the computer
sleep, and Discord shows it offline; it catches up on missed ✅ reactions and ranks when it
starts again, but greetings missed meanwhile are not sent. GitHub keeps the code and cannot
run it (GitHub Pages serves web pages only). Running it anywhere but the owner's computer is
a new outside service, and the owner's decision.

## On a new computer

Everything except `.env` is in this repository, so a lost laptop costs nothing but the
settings:

1. Install [Node 24 or later](https://nodejs.org) and [Git](https://git-scm.com).
2. `git clone https://github.com/wconnorg/agentzero.git`, then `npm install` in that folder.
3. Copy `.env.example` to `.env` and fill it in again:
   - `DISCORD_TOKEN`: developer portal, Agent Zero's application, Bot tab, **Reset Token**
     (Discord never shows the old one again). `npm run discord:check` confirms it is Agent
     Zero's and that the bot is in the server.
   - The server, role and channel ids: right-click each in Discord, "Copy ID".
   - `INTERNAL_API_SECRET`: `npm run secret:new`, paste the new value over Vercel's
     (Production) and redeploy.
4. `npm start`.

Nothing else was lost with the old computer: the bot keeps no data of its own, and ranks
live on the website.

## When something is wrong

The bot says what to fix in its log. The usual ones:

| Log says | Fix |
| --- | --- |
| `settings need fixing` | The listed `.env` variables. |
| `Discord refused the Server Members intent` | Developer portal, Bot tab, Server Members Intent on, then Save Changes. Already on? `npm run discord:check` names the application the token belongs to and links its Bot page. |
| `the bot is not in the server GUILD_ID names` | Open the invite link it prints, or put the id of the server it lists in `GUILD_ID`. |
| `cannot give "…"` / `Missing Permissions` | Agent Zero's role above that role; Manage Roles on. |
| `VERIFY_CHANNEL_ID is not set` | The verify channel's id in `VERIFY_CHANNEL_ID`; `WELCOME_CHANNEL_ID` is the join greetings' channel. |
| `could not post the greeting` / `farewell` | Allow Agent Zero View Channel and Send Messages in the welcome or goodbye channel. |
| `the website refused the secret (401)` | `INTERNAL_API_SECRET` differs between `.env` and Vercel: `npm run secret:new`, paste into Vercel (Production), redeploy. |
| `the website's internal API is off (503)` | Set `INTERNAL_API_SECRET` on Vercel (Production) and redeploy. |
| `Vercel's firewall blocked the bot (403 …)` | Vercel Firewall (step 3). The bot waits 10 minutes between tries. |
| `the website asked the bot to slow down (429)` | Nothing: the bot waits as long as it is told. |
| `the website has rank(s) the bot has no role for` | A new rank on the website: add it to `RANK_ROLE_VARIABLES` in `src/config.ts` and its role id to `.env`. Until then, those members get no role for it. |

A failed sync changes no roles and is tried again later, waiting longer after each failure
in a row (up to 30 minutes).

## Changing things

- **The verify text** is `VERIFY_TEXT` in `src/verify.ts`. On its next start the bot edits
  the posted message to match; the reactions stay.
- **The greetings** are `greeting` and `farewell` in `src/greetings.ts`.
- **Moving the verify message:** put the new channel's id in `VERIFY_CHANNEL_ID`, delete the
  old message and restart the bot (Ctrl+C, `npm start`): it posts a fresh verify message in
  a channel that has none. The bot reads `.env` only when it starts.
- **A new rank:** one line in `RANK_ROLE_VARIABLES` in `src/config.ts`, one variable in
  `.env` and `.env.example`.
