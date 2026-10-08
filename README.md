# Agent Zero

ZeroCorps' only Discord bot, for one server. It does four things:

1. **Verify, welcome and goodbye.** It posts a verify message in the verify channel;
   reacting with ✅ gives Verified, and removing the ✅ takes it away again. The optional
   alerts message works the same way: reacting with 🔔 gives the alerts role, for you to
   @mention when you post analysis. It posts "Welcome @user!" in the welcome channel when
   someone joins, and "Seeya @user!" in the goodbye channel when someone leaves, is kicked
   or is banned. This is the bot's own business: the website never touches it.
2. **Rank roles, from zerocorps.org.** On start and every few minutes it reads every linked
   member's rank from the website and gives the role for it. **A linked member never loses a
   rank role**: only unlinking Discord on the website takes Bronze away (an unlinked member
   drops out of the website's list). When someone joins, it asks the website about them and
   gives their rank role straight away.
3. **Optionally, "Users: N":** a channel named after how many ZeroCorps accounts there are
   (email-verified, with a username chosen).
4. **Optionally, the day's red and orange folders:** every morning at 06:00 Chicago time,
   two hours before the New York open, one line per high (🔴) or medium (🟠) impact event of
   the day in the chosen currencies, from Forex Factory's calendar, with each time shown in
   the reader's own time zone. Weekdays always, even to say there is nothing; weekends only
   when there is something.

The website is the source of truth for ranks. The bot stores nothing on disk and keeps
nothing but Discord ids in memory. Besides Discord and the website, it calls only Forex
Factory's public calendar feed, for the calendar. The contract with the website is
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

- **Role order:** in Server Settings, Roles, drag Agent Zero's role **above Verified,
  Bronze and the alerts role**. A bot can only give roles below its own.
- **The verify channel** (`VERIFY_CHANNEL_ID`) holds the verify message and nothing else.
  Everyone can see it and read its history, **Verified included** (they need it to remove
  their ✅), but only the bot posts there. Deny Add Reactions too: members can still click
  the bot's ✅, but cannot add others. The bot needs View Channel, Send Messages, Read
  Message History and Add Reactions there. It never pins anything: it finds its verify
  message again by its own ✅, so leave that ✅ in place.
- **The alerts channel and role (optional):** set up like the verify channel: everyone can
  see it and read its history, only the bot posts, and members cannot add reactions, only
  click the bot's 🔔. The bot needs the same four permissions there. Put the ids in
  `ALERTS_CHANNEL_ID` and `ALERTS_ROLE_ID` (both or neither). To @mention the role when you
  post analysis, allow that in the role's settings ("Allow anyone to @mention this role"),
  or mention it as an admin.
- **The welcome and goodbye channels** (`WELCOME_CHANNEL_ID`, `GOODBYE_CHANNEL_ID`, both
  optional): the bot needs View Channel and Send Messages in each. Neither may be the verify
  channel.
- **The verified-only channels:** on each one (or on its category), deny View Channel to
  @everyone and allow it to Verified. Then losing Verified hides them again by itself; the
  bot only gives and takes the role. Ranked channels work the same way with Bronze.
- **Users (optional):** make a channel (a voice channel members cannot join works well),
  allow the bot **Manage Channels on that channel only**, and put its id in
  `STATS_CHANNEL_ID`. The bot renames it to "Users: N" at most every five minutes.
- **The calendar channel (optional):** the bot needs View Channel, Send Messages and Read
  Message History there (the last one to see whether it already posted today), and its id
  goes in `CALENDAR_CHANNEL_ID`. It may not be the verify channel.

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
which greetings are on and in which channels, whether the calendar is on, and a first
`rank sync:` line; after that, only role changes, greetings, calendar posts and problems.

### Keeping it running (Windows)

Instead of a terminal, let Windows run it:

```sh
npm run autostart -- install
```

That registers a Windows scheduled task named "Agent Zero" (Task Scheduler is part of
Windows: nothing is installed, and no admin rights are needed). The task starts the bot,
with no window, whenever you sign in to Windows, and starts it again two minutes after a
crash (up to 90 times in a row, then it gives up); it also starts it right away. From then on:

| Command | Does |
| --- | --- |
| `npm run autostart -- status` | Whether the bot is running, and the last lines of its log. |
| `npm run autostart -- log` | The last 40 lines of its log. |
| `npm run autostart -- stop` / `start` | Stop the bot, or start it again, by hand. |
| `npm run autostart -- remove` | Stop it and delete the task; `npm start` is then the only way to run it. |

The log is in `%LOCALAPPDATA%\Agent Zero\agent-zero.log`; it starts over every time the
task starts, so it never grows. Run `npm start` only while the task's copy is stopped: two
copies of the bot would greet every newcomer twice. On macOS or Linux, a launchd or systemd
entry running `npm start` does the same job.

**The bot is online only while the laptop is awake and you are signed in.** Let the
computer sleep, and Discord shows it offline until it wakes; the bot then reconnects by
itself and catches up on missed ✅ reactions and ranks, but greetings missed meanwhile are
not sent. GitHub keeps the code and cannot run it (GitHub Pages serves web pages only).
Running it anywhere but the owner's computer is a new outside service, and the owner's
decision.

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
4. `npm run autostart -- install` (Windows), or `npm start` in a terminal.

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
| `the alerts message is off:` | The alerts channel: its id in `ALERTS_CHANNEL_ID`, and the same four permissions as the verify channel. Then restart the bot. |
| `could not update the Users channel` | Allow Agent Zero View Channel and Manage Channels on that channel. After a rename by hand, it waits five minutes. |
| `calendar failed: the bot needs View Channel, Send Messages and Read Message History` | Allow Agent Zero those three in the calendar channel. |
| `calendar failed: Forex Factory answered HTTP 429` | Nothing: the bot waits and tries again, longer after each failure. |
| `calendar failed: the Forex Factory feed had no events the bot could read` | The feed was empty or changed shape; the bot tries again. If it goes on for days, the feed's format changed and `parseEvent` in `src/calendar.ts` needs a look. |
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
- **The alerts text** is `ALERTS_TEXT` in `src/alerts.ts`, the same way.
- **The greetings** are `greeting` and `farewell` in `src/greetings.ts`.
- **Moving the verify message:** put the new channel's id in `VERIFY_CHANNEL_ID`, delete the
  old message and restart the bot: it posts a fresh verify message in a channel that has none.
- **Restarting the bot:** `npm run autostart -- stop`, then `npm run autostart -- start` (or
  Ctrl+C and `npm start` in a terminal). The bot reads `.env` only when it starts, so every
  change there needs a restart too.
- **A new rank:** one line in `RANK_ROLE_VARIABLES` in `src/config.ts`, one variable in
  `.env` and `.env.example`.
- **The calendar:** the time is `POST_AT` in `src/calendar.ts` (06:00 Chicago); the
  currencies are `CALENDAR_CURRENCIES` in `.env`; what a line looks like, and any filter on
  which events to show, is `lines` in `src/calendar.ts`.
