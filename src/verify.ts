import { PermissionFlagsBits, type Guild, type GuildTextBasedChannel, type Message } from "discord.js";
import { log } from "./log.ts";

/**
 * The verify channel: the verify message and the verified role. Entirely the bot's own,
 * never the website's. The verify channel holds this one message; join and leave greetings
 * have their own channels (greetings.ts).
 *
 * The verified role follows a member's own ✅ on the bot's verify message (the owner,
 * 2026-09-29): reacting gives it, and removing the ✅ takes it away, which hides the
 * verified-only channels again (Discord's channel permissions do the hiding). The bot also
 * gives it back to a member who returns with their ✅ still there, and on start to anyone
 * who reacted while it was off.
 *
 * The bot finds its verify message again by the ✅ it keeps on it, searching back through
 * the channel. It never pins it: Discord would announce the pin in the channel, and the
 * owner wants no such notices.
 */

export const VERIFY_EMOJI = "✅";

/**
 * The verify message. Edit it here: on its next start the bot edits the posted message to
 * match, and the reactions stay. The angle brackets stop Discord previewing the link.
 */
export const VERIFY_TEXT = [
  "**Welcome to ZeroCorps.**",
  "",
  `React with ${VERIFY_EMOJI} below to verify and open the rest of the server.`,
  "",
  "Learn to trade with ZeroCorps Academy: <https://zerocorps.org/academy>",
  "Link your Discord in the Academy's settings.",
].join("\n");

const NEEDED_IN_CHANNEL = {
  "View Channel": PermissionFlagsBits.ViewChannel,
  "Send Messages": PermissionFlagsBits.SendMessages,
  "Read Message History": PermissionFlagsBits.ReadMessageHistory,
  "Add Reactions": PermissionFlagsBits.AddReactions,
};

export async function openVerifyChannel(guild: Guild, channelId: string): Promise<GuildTextBasedChannel> {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) {
    throw new Error("VERIFY_CHANNEL_ID names no text channel in the server");
  }
  const permissions = channel.permissionsFor(await guild.members.fetchMe());
  const missing = Object.entries(NEEDED_IN_CHANNEL)
    .filter(([, flag]) => !permissions.has(flag))
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`in the verify channel the bot needs: ${missing.join(", ")}`);
  }
  return channel;
}

/** The little of a message that picking the verify message looks at. */
type Candidate = {
  author: { id: string };
  reactions: { cache: { get(emoji: string): { me: boolean } | undefined } };
};

/**
 * The verify message among messages listed newest first: the newest one the bot wrote that
 * carries the bot's own ✅. Nothing else the bot writes carries it.
 */
export function pickVerifyMessage<M extends Candidate>(messages: Iterable<M>, botId: string): M | undefined {
  for (const message of messages) {
    if (message.author.id === botId && message.reactions.cache.get(VERIFY_EMOJI)?.me) return message;
  }
  return undefined;
}

/** How far back the bot searches for its verify message: 20 pages of 100 messages. */
const SEARCH_PAGES = 20;

/**
 * The verify message, posted if there is none, with its text current and the bot's ✅ on
 * it. Members may react in the channel but not post.
 */
export async function ensureVerifyMessage(channel: GuildTextBasedChannel, botId: string): Promise<Message<true>> {
  let message = await findVerifyMessage(channel, botId);
  if (!message) {
    message = await channel.send({ content: VERIFY_TEXT, allowedMentions: { parse: [] } });
    log.info("posted the verify message");
  } else if (message.content !== VERIFY_TEXT) {
    message = await message.edit({ content: VERIFY_TEXT, allowedMentions: { parse: [] } });
    log.info("updated the verify message's text");
  }
  if (!message.reactions.cache.get(VERIFY_EMOJI)?.me) await message.react(VERIFY_EMOJI);
  return message;
}

/** Searches the channel newest first, a page of 100 messages at a time. */
async function findVerifyMessage(channel: GuildTextBasedChannel, botId: string): Promise<Message<true> | undefined> {
  let before: string | undefined;
  for (let page = 0; page < SEARCH_PAGES; page++) {
    const messages = await channel.messages.fetch({ limit: 100, before });
    const found = pickVerifyMessage(messages.values(), botId);
    if (found || messages.size < 100) return found;
    before = [...messages.keys()].reduce((a, b) => (BigInt(a) < BigInt(b) ? a : b));
  }
  return undefined;
}

/** Everyone with a ✅ on the message, the bot included. */
export async function fetchReactors(message: Message): Promise<Set<string>> {
  const ids = new Set<string>();
  const reaction = message.reactions.cache.get(VERIFY_EMOJI);
  if (!reaction) return ids;
  let after: string | undefined;
  for (;;) {
    const page = await reaction.users.fetch({ limit: 100, after });
    for (const id of page.keys()) ids.add(id);
    if (page.size < 100) return ids;
    after = [...page.keys()].reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b));
  }
}

/**
 * Gives or takes the verified role. Straight to Discord, without trusting the member cache,
 * which can lag a moment behind a change just made; giving a role twice is harmless.
 */
export async function setVerified(guild: Guild, memberId: string, roleId: string, on: boolean): Promise<void> {
  const reason = on
    ? `Reacted ${VERIFY_EMOJI} to the verify message`
    : `Removed ${VERIFY_EMOJI} from the verify message`;
  if (on) await guild.members.addRole({ user: memberId, role: roleId, reason });
  else await guild.members.removeRole({ user: memberId, role: roleId, reason });
}
