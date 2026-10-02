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
import { ConfigError, readConfig, type Config } from "./config.ts";
import { createMemberList, describeDiscordError, inviteUrl, isDiscordCode, isMissingPermission } from "./discord.ts";
import { errorMessage, log } from "./log.ts";
import { createRankSync } from "./rank-sync.ts";
import { repeat } from "./schedule.ts";
import { farewell, greeting, openGreetingChannel } from "./greetings.ts";
import { createAcademyUsersChannel } from "./stats.ts";
import { VERIFY_EMOJI, ensureVerifyMessage, fetchReactors, openVerifyChannel, setVerified } from "./verify.ts";
import { createWebsite } from "./website.ts";

/**
 * Agent Zero, ZeroCorps' only Discord bot, for one server:
 *  - the verified role, held while a member's ✅ is on its verify message (the bot's own
 *    business);
 *  - "Welcome @user!" in the welcome channel and "Seeya @user!" in the goodbye channel;
 *  - the rank roles, synced from zerocorps.org on start and every few minutes, and
 *    restored when a member joins;
 *  - optionally, an "Academy Users: N" channel counting linked Discord accounts.
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
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessageReactions],
  // Reactions arrive even for a verify message that has left the message cache, and a
  // departure even for a member the cache does not hold.
  partials: [Partials.Message, Partials.Reaction, Partials.User, Partials.GuildMember],
  // A channel rename over Discord's limit fails at once instead of waiting up to ten
  // minutes, which would hold up the rank sync (stats.ts). Everything else still waits.
  rest: { rejectOnRateLimit: (limit) => limit.method.toUpperCase() === "PATCH" && limit.route === "/channels/:id" },
});

const loops: { stop(): void }[] = [];

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

  const message = await ensureVerifyMessage(await openVerifyChannel(guild, config.verifyChannelId), ready.user.id);
  const welcomeChannel = config.welcomeChannelId
    ? await openGreetingChannel(guild, config.welcomeChannelId, "WELCOME_CHANNEL_ID")
    : undefined;
  const goodbyeChannel = config.goodbyeChannelId
    ? await openGreetingChannel(guild, config.goodbyeChannelId, "GOODBYE_CHANNEL_ID")
    : undefined;
  const members = createMemberList(guild);
  const ranks = createRankSync(guild, members, website, config.rankRoles);
  const reactors = new Set<string>();

  // One change at a time for each member, so a quick ✅ and un-✅ end the right way round.
  const turns = new Map<string, Promise<void>>();
  const verified = (memberId: string, on: boolean) => {
    const turn = (turns.get(memberId) ?? Promise.resolve()).then(async () => {
      try {
        await setVerified(guild, memberId, config.verifiedRoleId, on);
        log.info(`${on ? "verified" : "unverified"} ${memberId}`);
      } catch (error) {
        if (isDiscordCode(error, RESTJSONErrorCodes.UnknownMember)) return;
        log.error(`could not ${on ? "give" : "take"} the verified role for ${memberId}: ${describeDiscordError(error)}`);
      }
    });
    turns.set(memberId, turn);
    void turn.then(() => turns.get(memberId) === turn && turns.delete(memberId));
    return turn;
  };
  const isVerifyReaction = (reaction: { message: { id: string }; emoji: { name: string | null } }) =>
    reaction.message.id === message.id && reaction.emoji.name === VERIFY_EMOJI;

  // ✅ changes that arrive while a catch-up is reading the list, applied on top of what it read.
  const liveChanges = new Map<string, boolean>();
  let catchingUp = false;
  const liveReaction = (userId: string, on: boolean) => {
    if (on) reactors.add(userId);
    else reactors.delete(userId);
    if (catchingUp) liveChanges.set(userId, on);
    void verified(userId, on);
  };

  // Listen before reading the reactions, so none made in between is missed.
  ready.on(Events.MessageReactionAdd, (reaction, user) => {
    if (!isVerifyReaction(reaction) || user.id === ready.user.id || user.bot) return;
    liveReaction(user.id, true);
  });
  ready.on(Events.MessageReactionRemove, (reaction, user) => {
    if (!isVerifyReaction(reaction) || user.id === ready.user.id || user.bot) return;
    liveReaction(user.id, false);
  });
  // A moderator cleared the reactions: put the bot's ✅ back so members can still verify.
  // Nobody loses the verified role for this; only removing their own ✅ does that.
  const cleared = () => {
    reactors.clear();
    message.react(VERIFY_EMOJI).catch((error: unknown) => {
      const reason = isMissingPermission(error)
        ? "the bot needs Add Reactions and Read Message History in the verify channel"
        : errorMessage(error);
      log.error(`could not put ${VERIFY_EMOJI} back on the verify message: ${reason}`);
    });
  };
  ready.on(Events.MessageReactionRemoveAll, (removedFrom) => {
    if (removedFrom.id === message.id) cleared();
  });
  ready.on(Events.MessageReactionRemoveEmoji, (reaction) => {
    if (isVerifyReaction(reaction)) cleared();
  });

  const post = (channel: GuildTextBasedChannel | undefined, content: string, ping: string[], about: string) => {
    channel?.send({ content, allowedMentions: { users: ping } }).catch((error: unknown) => {
      const reason = isMissingPermission(error)
        ? `the bot needs View Channel and Send Messages in #${channel.name}`
        : errorMessage(error);
      log.error(`could not post the ${about}: ${reason}`);
    });
  };

  ready.on(Events.GuildMemberAdd, (member) => {
    if (member.guild.id !== guild.id || member.user.bot) return;
    post(welcomeChannel, greeting(member.id), [member.id], `greeting for ${member.id}`);
    // Back in the server with their ✅ still on the message.
    if (reactors.has(member.id)) void verified(member.id, true);
    ranks.restore(member).catch((error: unknown) => {
      log.error(`could not restore the rank role of ${member.id}: ${errorMessage(error)}; the next sync tries again`);
    });
  });
  // Leaving, a kick and a ban all arrive as this one event.
  ready.on(Events.GuildMemberRemove, (member) => {
    if (member.guild.id !== guild.id || member.user.bot) return;
    post(goodbyeChannel, farewell(member.id), [], `farewell for ${member.id}`);
  });

  /**
   * Reads who has a ✅ now and gives Verified to any of them who lacks it: at start, and
   * whenever the connection comes back, because reactions made while the bot was away never
   * arrive as events. It never takes Verified away (members verified before the verify
   * message existed keep it).
   */
  const catchUp = async () => {
    if (catchingUp) return;
    catchingUp = true;
    try {
      const now = await fetchReactors(message);
      now.delete(ready.user.id);
      for (const [id, on] of liveChanges) {
        if (on) now.add(id);
        else now.delete(id);
      }
      reactors.clear();
      for (const id of now) reactors.add(id);
      const everyone = await members();
      for (const id of reactors) {
        const member = everyone.get(id);
        if (member && !member.user.bot && !member.roles.cache.has(config.verifiedRoleId)) await verified(id, true);
      }
    } finally {
      catchingUp = false;
      liveChanges.clear();
    }
  };
  await catchUp();
  log.info(`verify message ready; ${reactors.size} member(s) have reacted`);

  // Back after a gap (a resume, or signing in afresh after a long sleep): catch up again.
  const catchUpAgain = (after: string) => {
    catchUp()
      .then(() => log.info(`caught up on ${VERIFY_EMOJI} after ${after}`))
      .catch((error: unknown) => log.error(`could not catch up on ${VERIFY_EMOJI} after ${after}: ${errorMessage(error)}`));
  };
  ready.on(Events.ShardResume, () => catchUpAgain("a reconnect"));
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
      `${goodbyeChannel ? `goodbye in #${goodbyeChannel.name}` : "no goodbye"}`,
  );

  const academyUsers = config.statsChannelId
    ? createAcademyUsersChannel(guild, config.statsChannelId)
    : undefined;
  loops.push(
    repeat("rank sync", config.syncIntervalMs, async () => {
      const linked = await ranks.syncAll();
      await academyUsers?.show(linked);
    }),
  );
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
  const roles = [["VERIFIED_ROLE_ID", config.verifiedRoleId], ...config.rankRoles] as const;
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
