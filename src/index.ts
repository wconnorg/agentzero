import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Guild,
  type GuildTextBasedChannel,
} from "discord.js";
import { checkPing, createCalendar, openCalendarChannel, postAtLabel, TICK_MS as CALENDAR_TICK_MS } from "./calendar.ts";
import { ConfigError, readConfig, type Config } from "./config.ts";
import { createMemberList, describeDiscordError, inviteUrl, isDiscordCode, isMissingPermission } from "./discord.ts";
import { errorMessage, log } from "./log.ts";
import { clearCommands, createMusic, registerCommands, type Music } from "./music.ts";
import { createRankSync } from "./rank-sync.ts";
import { repeat } from "./schedule.ts";
import { farewell, greeting, openGreetingChannel } from "./greetings.ts";
import { createUsersChannel } from "./stats.ts";
import { ALERTS_EMOJI, ALERTS_TEXT } from "./alerts.ts";
import { startReactionRole, type ReactionRole } from "./reaction-role.ts";
import { VERIFY_EMOJI, VERIFY_TEXT } from "./verify.ts";
import { createWebsite } from "./website.ts";
import { toolVersions } from "./ytdlp.ts";

/**
 * Agent Zero, ZeroCorps' only Discord bot, for one server:
 *  - the verified role, held while a member's ✅ is on its verify message (the bot's own
 *    business), and likewise the optional alerts role, held while a member's 🔔 is on the
 *    alerts message;
 *  - "Welcome @user!" in the welcome channel and "Seeya @user!" in the goodbye channel;
 *  - the rank roles, synced from zerocorps.org on start and every few minutes, and
 *    restored when a member joins;
 *  - optionally, a "Users: N" channel counting ZeroCorps accounts;
 *  - optionally, the day's red and orange folders each morning in the calendar channel;
 *  - optionally, music: slash commands in the music channel, played in a voice channel.
 */

function loadConfig(): Config {
  try {
    return readConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}

const config = loadConfig();
const website = createWebsite({ origin: config.apiOrigin, secret: config.apiSecret });

const client = new Client({
  // Server Members is a privileged intent: it must be switched on in the developer portal.
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
  ],
  // Reactions arrive even for a verify message that has left the message cache, and a
  // departure even for a member the cache does not hold.
  partials: [Partials.Message, Partials.Reaction, Partials.User, Partials.GuildMember],
  // A channel rename over Discord's limit fails at once instead of waiting up to ten
  // minutes for Discord to allow it (stats.ts). Everything else still waits.
  rest: { rejectOnRateLimit: (limit) => limit.method.toUpperCase() === "PATCH" && limit.route === "/channels/:id" },
});

const loops: { stop(): void }[] = [];
let music: Music | undefined;

client.once(Events.ClientReady, (ready) => {
  start(ready).catch((error: unknown) => {
    log.error(`could not start: ${describeDiscordError(error)}`);
    void shutdown(1);
  });
});

async function start(ready: Client<true>) {
  log.info(`signed in to Discord as ${ready.user.tag}`);
  const guild = await ready.guilds.fetch(config.guildId).catch((error: unknown) => {
    const absent =
      isDiscordCode(error, RESTJSONErrorCodes.UnknownGuild) || isDiscordCode(error, RESTJSONErrorCodes.MissingAccess);
    if (absent) return null;
    throw error;
  });
  if (!guild) throw new Error(notInServer(ready));
  await checkRoles(guild);

  const welcomeChannel = config.welcomeChannelId
    ? await openGreetingChannel(guild, config.welcomeChannelId, "WELCOME_CHANNEL_ID")
    : undefined;
  const goodbyeChannel = config.goodbyeChannelId
    ? await openGreetingChannel(guild, config.goodbyeChannelId, "GOODBYE_CHANNEL_ID")
    : undefined;
  const calendarChannel = config.calendarChannelId
    ? await openCalendarChannel(guild, config.calendarChannelId)
    : undefined;
  if (calendarChannel && config.alertsRoleId) await checkPing(guild, calendarChannel, config.alertsRoleId);
  const members = createMemberList(guild);
  const ranks = createRankSync(guild, members, website, config.rankRoles);
  // The verify message is the bot's reason to be: without it, stop and say why.
  const verify = await startReactionRole(guild, members, ready.user.id, {
    messageName: "verify",
    roleName: "verified",
    channelVariable: "VERIFY_CHANNEL_ID",
    channelId: config.verifyChannelId,
    emoji: VERIFY_EMOJI,
    text: VERIFY_TEXT,
    roleId: config.verifiedRoleId,
    gave: (id) => `verified ${id}`,
    took: (id) => `unverified ${id}`,
  });
  // The alerts message is optional: a problem with its channel only switches it off.
  let alerts: ReactionRole | undefined;
  if (config.alertsChannelId && config.alertsRoleId) {
    try {
      alerts = await startReactionRole(guild, members, ready.user.id, {
        messageName: "alerts",
        roleName: "alerts",
        channelVariable: "ALERTS_CHANNEL_ID",
        channelId: config.alertsChannelId,
        emoji: ALERTS_EMOJI,
        text: ALERTS_TEXT,
        roleId: config.alertsRoleId,
        gave: (id) => `alerts on for ${id}`,
        took: (id) => `alerts off for ${id}`,
      });
    } catch (error) {
      log.warn(`the alerts message is off: ${errorMessage(error)}`);
    }
  }
  const reactionRoles = alerts ? [verify, alerts] : [verify];

  // Listen before reading the reactions, so none made in between is missed.
  ready.on(Events.MessageReactionAdd, (reaction, user) => {
    for (const role of reactionRoles) void role.reacted(reaction, user, true);
  });
  ready.on(Events.MessageReactionRemove, (reaction, user) => {
    for (const role of reactionRoles) void role.reacted(reaction, user, false);
  });
  ready.on(Events.MessageReactionRemoveAll, (removedFrom) => {
    for (const role of reactionRoles) role.allCleared(removedFrom.id);
  });
  ready.on(Events.MessageReactionRemoveEmoji, (reaction) => {
    for (const role of reactionRoles) role.emojiCleared(reaction);
  });

  const post = (channel: GuildTextBasedChannel | undefined, content: string, ping: string[], about: string) => {
    channel
      ?.send({ content, allowedMentions: { users: ping } })
      .then(() => log.info(`posted the ${about} in #${channel.name}`))
      .catch((error: unknown) => {
        const reason = isMissingPermission(error)
          ? `the bot needs View Channel and Send Messages in #${channel.name}`
          : errorMessage(error);
        log.error(`could not post the ${about}: ${reason}`);
      });
  };

  ready.on(Events.GuildMemberAdd, (member) => {
    if (member.guild.id !== guild.id || member.user.bot) return;
    post(welcomeChannel, greeting(member.id), [member.id], `greeting for ${member.id}`);
    // Back in the server with their reaction still on a message: the role comes back.
    for (const role of reactionRoles) void role.rejoined(member.id);
    ranks.restore(member).catch((error: unknown) => {
      log.error(`could not restore the rank role of ${member.id}: ${errorMessage(error)}; the next sync tries again`);
    });
  });
  // Leaving, a kick and a ban all arrive as this one event.
  ready.on(Events.GuildMemberRemove, (member) => {
    if (member.guild.id !== guild.id || member.user.bot) return;
    post(goodbyeChannel, farewell(member.id), [], `farewell for ${member.id}`);
  });

  // Who has reacted now: at start, and whenever the connection comes back, because reactions
  // made while the bot was away never arrive as events (reaction-role.ts says what it does).
  const catchUp = async () => {
    for (const role of reactionRoles) await role.catchUp();
  };
  await catchUp();
  for (const role of reactionRoles) log.info(`${role.messageName} message ready; ${role.count} member(s) have reacted`);

  // Back after a gap (a resume, or signing in afresh after a long sleep): catch up again.
  const catchUpAgain = (after: string) => {
    catchUp()
      .then(() => log.info(`caught up on reactions after ${after}`))
      .catch((error: unknown) => log.error(`could not catch up on reactions after ${after}: ${errorMessage(error)}`));
  };
  // The connection's ups and downs, as they happen: a command that reaches the bot after
  // Discord's three-second limit was almost always sent during one of these gaps.
  ready.on(Events.ShardReconnecting, () => log.warn("the connection to Discord dropped; reconnecting"));
  ready.on(Events.ShardResume, (_shard, replayed) => {
    log.info(`the connection to Discord is back; Discord replayed ${replayed} event(s) missed meanwhile`);
    catchUpAgain("a reconnect");
  });
  ready.on(Events.ShardReady, () => catchUpAgain("signing in again"));
  // A close Discord will not recover from (a reset token, the intent switched off) would
  // leave the bot running but deaf: stop, and say why.
  ready.on(Events.ShardDisconnect, (event) => {
    log.error(
      `Discord closed the connection for good (code ${event.code}): check DISCORD_TOKEN and the ` +
        "Server Members intent in the developer portal, then start the bot again",
    );
    void shutdown(1);
  });
  log.info(
    `greetings: ${welcomeChannel ? `welcome in #${welcomeChannel.name}` : "no welcome"}, ` +
      `${goodbyeChannel ? `goodbye in #${goodbyeChannel.name}` : "no goodbye"}; ` +
      `calendar: ${calendarChannel ? `#${calendarChannel.name} at ${postAtLabel()} (${config.calendarCurrencies.join(", ")})` : "off"}` +
      `${calendarChannel && config.alertsRoleId ? ", pinging the alerts role" : ""}`,
  );

  loops.push(repeat("rank sync", config.syncIntervalMs, () => ranks.syncAll()));
  if (config.statsChannelId) {
    // Its own loop, so a failed count never delays the roles, nor the other way round.
    const users = createUsersChannel(guild, config.statsChannelId);
    loops.push(
      repeat("users count", config.syncIntervalMs, async () => {
        const { academyMembers } = await website.stats();
        await users.show(academyMembers);
      }),
    );
  }
  if (calendarChannel) {
    const calendar = createCalendar(calendarChannel, ready.user.id, config.calendarCurrencies, {
      pingRoleId: config.alertsRoleId,
    });
    loops.push(repeat("calendar", CALENDAR_TICK_MS, () => calendar.tick()));
  }
  if (config.commandsChannelId) music = await startMusic(ready, guild, config.commandsChannelId);
  else log.info("music: off (COMMANDS_CHANNEL_ID is not set in .env)");
  // Commands from an earlier run must not stay in the server with no one answering them.
  if (!music) await clearCommands(ready, guild.id);
}

/** The music commands, when the two programs they need are there and the bot may add commands. */
async function startMusic(ready: Client<true>, guild: Guild, channelId: string): Promise<Music | undefined> {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    log.warn("COMMANDS_CHANNEL_ID names no channel in the server: music is off");
    return undefined;
  }
  const tools = await toolVersions();
  if (!tools.ytdlp || !tools.ffmpeg) {
    const missing = [tools.ytdlp ? "" : "yt-dlp", tools.ffmpeg ? "" : "ffmpeg"].filter(Boolean).join(" and ");
    const install = tools.ytdlp ? "winget install yt-dlp.FFmpeg" : "npm run ytdlp:update";
    log.warn(`music is off: ${missing} not found on the PATH. Install with "${install}", then start the bot again`);
    return undefined;
  }
  if (!(await registerCommands(ready, guild.id))) return undefined;
  const player = createMusic(guild, channelId);
  ready.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isChatInputCommand() && interaction.guildId === guild.id) void player.handle(interaction);
  });
  // The last listener left a voice channel: no point playing on.
  ready.on(Events.VoiceStateUpdate, (before) => {
    const left = before.channel;
    if (left && left.guild.id === guild.id && !left.members.some((member) => !member.user.bot)) player.emptied(left.id);
  });
  log.info(`music: commands in #${channel.name}; yt-dlp ${tools.ytdlp}, ffmpeg ${tools.ffmpeg}`);
  return player;
}

/** The servers the bot is in and its invite link: enough to tell a missing invite from a wrong GUILD_ID. */
function notInServer(ready: Client<true>): string {
  const servers = ready.guilds.cache.map((server) => `"${server.name}" (${server.id})`);
  return (
    "the bot is not in the server GUILD_ID names. " +
    (servers.length > 0
      ? `It is in: ${servers.join(", ")}. If one of those is the ZeroCorps server, put its id in GUILD_ID; if not, invite it: `
      : "It is in no server yet. Invite it: ") +
    inviteUrl(ready.application.id)
  );
}

/** Missing roles stop the bot; roles it cannot give only warn, so the owner can fix them live. */
async function checkRoles(guild: Guild) {
  const me = await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    log.warn("the bot lacks Manage Roles in the server: it cannot give any role");
  }
  const roles: [string, string][] = [["VERIFIED_ROLE_ID", config.verifiedRoleId], ...config.rankRoles];
  if (config.alertsRoleId) roles.push(["ALERTS_ROLE_ID", config.alertsRoleId]);
  for (const [label, roleId] of roles) {
    const role = await guild.roles.fetch(roleId);
    if (!role) throw new Error(`the ${label} role id names no role in the server`);
    if (!role.editable) {
      log.warn(`the bot cannot give "${role.name}": its own role must sit above it in Server Settings, Roles`);
    }
  }
}

async function shutdown(code: number) {
  for (const loop of loops) loop.stop();
  music?.shutdown();
  await client.destroy();
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
process.on("unhandledRejection", (error) => log.error(`unhandled: ${errorMessage(error)}`));
client.on(Events.Error, (error) => log.error(`Discord: ${error.message}`));

client.login(config.discordToken).catch((error: unknown) => {
  const message = errorMessage(error);
  log.error(
    /disallowed intents|privileged intent/i.test(message)
      ? "Discord refused the Server Members intent: switch it on in the developer portal (Bot tab) " +
          "and click Save Changes. If it already shows on, run `npm run discord:check`: it names the " +
          "application the token in .env belongs to."
      : `could not sign in to Discord: ${message}`,
  );
  process.exit(1);
});
