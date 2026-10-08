import { PermissionFlagsBits, RESTJSONErrorCodes, type Guild, type GuildTextBasedChannel, type Message } from "discord.js";
import { channelFix, describeDiscordError, isDiscordCode, isMissingPermission, listOf } from "./discord.ts";
import { errorMessage, log } from "./log.ts";

/**
 * A role that follows a member's own reaction on one message of the bot's: the verified
 * role on the verify message (verify.ts), and the alerts role on the alerts message
 * (alerts.ts). Reacting gives the role, and removing the reaction takes it away (the owner,
 * 2026-09-29), which is all the role ever does: Discord's channel permissions do the rest.
 * The bot also gives the role back to a member who returns with their reaction still there,
 * and on start to anyone who reacted while it was off. A moderator clearing the reactions
 * takes the role from nobody; the bot just puts its own reaction back.
 *
 * The bot finds its message again by the reaction it keeps on it, searching back through
 * the channel. It never pins it: Discord would announce the pin in the channel, and the
 * owner wants no such notices.
 */

/** One reaction role: its message, its role, and what to call them. */
export type ReactionRoleSpec = {
  /** What the message is called in the log: "verify" or "alerts". */
  messageName: string;
  /** What the role is called in the log: "verified" or "alerts". */
  roleName: string;
  /** The setting naming the channel, for errors. */
  channelVariable: string;
  channelId: string;
  emoji: string;
  text: string;
  roleId: string;
  /** The log lines for a member getting the role and losing it. */
  gave: (memberId: string) => string;
  took: (memberId: string) => string;
};

const NEEDED_IN_CHANNEL = {
  "View Channel": PermissionFlagsBits.ViewChannel,
  "Send Messages": PermissionFlagsBits.SendMessages,
  "Read Message History": PermissionFlagsBits.ReadMessageHistory,
  "Add Reactions": PermissionFlagsBits.AddReactions,
};

export async function openReactionChannel(guild: Guild, spec: ReactionRoleSpec): Promise<GuildTextBasedChannel> {
  const channel = await guild.channels.fetch(spec.channelId).catch(() => null);
  if (!channel?.isTextBased()) {
    throw new Error(`${spec.channelVariable} names no text channel in the server`);
  }
  const me = await guild.members.fetchMe();
  const permissions = channel.permissionsFor(me);
  const missing = Object.entries(NEEDED_IN_CHANNEL)
    .filter(([, flag]) => !permissions.has(flag))
    .map(([name]) => name);
  if (missing.length > 0) {
    // All four, not only the missing ones, so a later change for @everyone cannot shut it out again.
    throw new Error(
      `the bot cannot work in the ${spec.messageName} channel #${channel.name}: it lacks ${listOf(missing)}. ` +
        channelFix(channel.name, me.roles.botRole?.name ?? me.displayName, Object.keys(NEEDED_IN_CHANNEL)),
    );
  }
  return channel;
}

/** The little of a message that picking the bot's message looks at. */
type Candidate = {
  author: { id: string };
  reactions: { cache: { get(emoji: string): { me: boolean } | undefined } };
};

/**
 * The bot's message among messages listed newest first: the newest one the bot wrote that
 * carries the bot's own reaction with this emoji. Nothing else the bot writes carries it.
 */
export function pickMessage<M extends Candidate>(messages: Iterable<M>, botId: string, emoji: string): M | undefined {
  for (const message of messages) {
    if (message.author.id === botId && message.reactions.cache.get(emoji)?.me) return message;
  }
  return undefined;
}

/** How far back the bot searches for its message: 20 pages of 100 messages. */
const SEARCH_PAGES = 20;

/**
 * The bot's message, posted if there is none, with its text current and the bot's own
 * reaction on it. Members may react in the channel but not post.
 */
export async function ensureMessage(channel: GuildTextBasedChannel, botId: string, spec: ReactionRoleSpec): Promise<Message<true>> {
  let message = await findMessage(channel, botId, spec.emoji);
  if (!message) {
    message = await channel.send({ content: spec.text, allowedMentions: { parse: [] } });
    log.info(`posted the ${spec.messageName} message`);
  } else if (message.content !== spec.text) {
    message = await message.edit({ content: spec.text, allowedMentions: { parse: [] } });
    log.info(`updated the ${spec.messageName} message's text`);
  }
  if (!message.reactions.cache.get(spec.emoji)?.me) await message.react(spec.emoji);
  return message;
}

/** Searches the channel newest first, a page of 100 messages at a time. */
async function findMessage(channel: GuildTextBasedChannel, botId: string, emoji: string): Promise<Message<true> | undefined> {
  let before: string | undefined;
  for (let page = 0; page < SEARCH_PAGES; page++) {
    const messages = await channel.messages.fetch({ limit: 100, before });
    const found = pickMessage(messages.values(), botId, emoji);
    if (found || messages.size < 100) return found;
    before = [...messages.keys()].reduce((a, b) => (BigInt(a) < BigInt(b) ? a : b));
  }
  return undefined;
}

/** The little of a message that tracking its reactions needs; a discord.js Message fits. */
export type ReactionMessage = {
  id: string;
  react(emoji: string): Promise<unknown>;
  reactions: {
    cache: {
      get(emoji: string):
        | { users: { fetch(options: { limit: number; after?: string }): Promise<{ size: number; keys(): Iterable<string> }> } }
        | undefined;
    };
  };
};

/** Everyone with the reaction on the message, the bot included. */
export async function fetchReactors(message: ReactionMessage, emoji: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const reaction = message.reactions.cache.get(emoji);
  if (!reaction) return ids;
  let after: string | undefined;
  for (;;) {
    const page = await reaction.users.fetch({ limit: 100, after });
    for (const id of page.keys()) ids.add(id);
    if (page.size < 100) return ids;
    after = [...page.keys()].reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b));
  }
}

/** What gives and takes roles; a discord.js Guild fits. */
export type RoleGiver = {
  members: {
    addRole(options: { user: string; role: string; reason: string }): Promise<unknown>;
    removeRole(options: { user: string; role: string; reason: string }): Promise<unknown>;
  };
};

/** Everyone in the server, by id; discord.ts's member list fits. */
export type MemberSource = () => Promise<{
  get(id: string): { user: { bot: boolean }; roles: { cache: { has(roleId: string): boolean } } } | undefined;
}>;

export type ReactionLike = { message: { id: string }; emoji: { name: string | null } };
export type UserLike = { id: string; bot?: boolean | null };

export function createReactionRole(
  guild: RoleGiver,
  members: MemberSource,
  botId: string,
  message: ReactionMessage,
  spec: ReactionRoleSpec,
) {
  const { emoji, roleId } = spec;
  /** Who has the reaction, as far as the bot knows. */
  const reactors = new Set<string>();
  // One change at a time for each member, so a quick reaction and un-reaction end the right way round.
  const turns = new Map<string, Promise<void>>();
  // Changes that arrive while a catch-up is reading the list, applied on top of what it read.
  const liveChanges = new Map<string, boolean>();
  let catchingUp = false;

  /**
   * Gives or takes the role. Straight to Discord, without trusting the member cache, which
   * can lag a moment behind a change just made; giving a role twice is harmless.
   */
  const setRole = (memberId: string, on: boolean) => {
    const turn = (turns.get(memberId) ?? Promise.resolve()).then(async () => {
      const reason = on
        ? `Reacted ${emoji} to the ${spec.messageName} message`
        : `Removed ${emoji} from the ${spec.messageName} message`;
      try {
        if (on) await guild.members.addRole({ user: memberId, role: roleId, reason });
        else await guild.members.removeRole({ user: memberId, role: roleId, reason });
        log.info(on ? spec.gave(memberId) : spec.took(memberId));
      } catch (error) {
        if (isDiscordCode(error, RESTJSONErrorCodes.UnknownMember)) return;
        log.error(`could not ${on ? "give" : "take"} the ${spec.roleName} role for ${memberId}: ${describeDiscordError(error)}`);
      }
    });
    turns.set(memberId, turn);
    void turn.then(() => turns.get(memberId) === turn && turns.delete(memberId));
    return turn;
  };

  const mine = (reaction: ReactionLike) => reaction.message.id === message.id && reaction.emoji.name === emoji;

  // A moderator cleared the reactions: put the bot's own back so members can still react.
  // Nobody loses the role for this; only removing their own reaction does that.
  const putBack = () => {
    reactors.clear();
    message.react(emoji).catch((error: unknown) => {
      const reason = isMissingPermission(error)
        ? `the bot needs Add Reactions and Read Message History in the ${spec.messageName} channel`
        : errorMessage(error);
      log.error(`could not put ${emoji} back on the ${spec.messageName} message: ${reason}`);
    });
  };

  return {
    messageName: spec.messageName,
    /** How many have reacted, as far as the bot knows. */
    get count() {
      return reactors.size;
    },

    /** A reaction added (`on`) or removed; other messages, other emojis and bots are ignored. */
    reacted(reaction: ReactionLike, user: UserLike, on: boolean): Promise<void> {
      if (!mine(reaction) || user.id === botId || user.bot) return Promise.resolve();
      if (on) reactors.add(user.id);
      else reactors.delete(user.id);
      if (catchingUp) liveChanges.set(user.id, on);
      return setRole(user.id, on);
    },

    allCleared(messageId: string): void {
      if (messageId === message.id) putBack();
    },

    emojiCleared(reaction: ReactionLike): void {
      if (mine(reaction)) putBack();
    },

    /** Back in the server with their reaction still on the message: the role comes back. */
    rejoined(memberId: string): Promise<void> {
      return reactors.has(memberId) ? setRole(memberId, true) : Promise.resolve();
    },

    /**
     * Reads who has the reaction now and gives the role to any of them who lacks it: at
     * start, and whenever the connection comes back, because reactions made while the bot
     * was away never arrive as events. It never takes the role away (members who had it
     * before the message existed keep it).
     */
    async catchUp(): Promise<void> {
      if (catchingUp) return;
      catchingUp = true;
      try {
        const now = await fetchReactors(message, emoji);
        now.delete(botId);
        for (const [id, on] of liveChanges) {
          if (on) now.add(id);
          else now.delete(id);
        }
        reactors.clear();
        for (const id of now) reactors.add(id);
        const everyone = await members();
        for (const id of reactors) {
          const member = everyone.get(id);
          if (member && !member.user.bot && !member.roles.cache.has(roleId)) await setRole(id, true);
        }
      } finally {
        catchingUp = false;
        liveChanges.clear();
      }
    },
  };
}

export type ReactionRole = ReturnType<typeof createReactionRole>;

/** The message in its channel, with the bot's reaction on it, and the role that follows it. */
export async function startReactionRole(
  guild: Guild,
  members: MemberSource,
  botId: string,
  spec: ReactionRoleSpec,
): Promise<ReactionRole> {
  const channel = await openReactionChannel(guild, spec);
  const message = await ensureMessage(channel, botId, spec);
  return createReactionRole(guild, members, botId, message, spec);
}
