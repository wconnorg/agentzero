# Agent Zero: project rules

Agent Zero is ZeroCorps' only Discord bot (one server). The website, zerocorps.org, is a
separate public repository (github.com/wconnorg/zerocorps; locally `../zerocorps`). The
contract between them is `docs/INTERNAL-API.md` there: read it before changing
`src/website.ts`, and never change the website from this repository.

The owner's priorities, as on the website: security first; boring, standard code; as few
third parties as possible; as little personal data as possible.

- **Secrets.** `DISCORD_TOKEN` and `INTERNAL_API_SECRET` live only in `.env` (and the
  secret on Vercel). Never ask for, print, log or commit them. `.claude/settings.json`
  denies the file tools every env file except `.env.example`: keep that, and never work
  around it with a shell command or a script.
- **The repository is public** (github.com/wconnorg/agentzero): the owner's backup, so a
  fresh clone plus a filled-in `.env` must be a working bot. Before every push, check the
  commits for env files, secrets, real Discord ids and real addresses.
- **Data.** Store nothing beyond Discord ids, and nothing on disk. The website is the
  source of truth for ranks; the verified role is the bot's own and is never a rank role.
- **Role rules (owner, 2026-09-29).** A linked member never loses a rank role: only
  dropping out of the website's list (unlinking Discord) takes one away, even though the
  contract says a `rank: null` member loses them. The verified role follows the member's
  own ✅: removing it takes the role; a moderator clearing all reactions does not.
- **Only the live internal API.** The bot calls https://zerocorps.org and nothing else of
  the website's: never localhost (the internal API is off on the laptop, and port 3000 is
  the website's dev server) and never the website's database. A new endpoint or field is
  the owner's to take to the website chat.
- **Ask before adding any new external service**, including where the bot is hosted
  (it runs on the owner's laptop while testing). Approved so far: Forex Factory's public
  calendar feed, read once a day for the calendar post; and for the music commands, the
  programs yt-dlp (its unpacked build from its GitHub release, installed by
  `scripts/update-yt-dlp.ps1`) and FFmpeg (winget) on the PATH, the npm packages
  @discordjs/voice and @snazzah/davey, the music sites in `ALLOWED_HOSTS` (YouTube,
  SoundCloud, Bandcamp, Vimeo, Mixcloud) that yt-dlp fetches from, and Spotify's public
  oEmbed endpoint for the title of a Spotify link (the owner, 2026-10-08, knowing YouTube's
  terms frown on bots).
- **The laptop is weak: one agent at a time.** Subagents and workflow agents run one after
  another, never in parallel.
- **Never hammer the website:** respect 429's `retryAfterSeconds`, and back off on
  Vercel's 403 checkpoint. A failed or malformed answer must never change a role.
- Node 24 runs the TypeScript directly (type stripping): erasable syntax only, `.ts` in
  imports, `import type` for types. `npm run check` (type check and tests) before handing
  work back.
