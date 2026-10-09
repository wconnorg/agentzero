import {
  DiscordAPIError,
  GatewayRateLimitError,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Collection,
  type Guild,
  type GuildMember,
} from "discord.js";
import { errorMessage, log } from "./log.ts";

export const isDiscordCode = (error: unknown, code: RESTJSONErrorCodes) =>
  error instanceof DiscordAPIError && error.code === code;

/** Discord refused for lack of a permission (Missing Access means no View Channel). */
export const isMissingPermission = (error: unknown) =>
  isDiscordCode(error, RESTJSONErrorCodes.MissingPermissions) || isDiscordCode(error, RESTJSONErrorCodes.MissingAccess);

/** "A", "A and B", "A, B and C". */
export const listOf = (items: readonly string[]) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/**
 * The clicks that give the bot permissions in one channel. An allow for the bot's own role
 * on the channel itself wins over a deny for @everyone there or on its category, which is
 * how a locked-down channel usually shuts the bot out too.
 */
export const channelFix = (channelName: string, botRoleName: string, permissions: readonly string[]) =>
  `In Discord: right-click #${channelName}, Edit Channel, Permissions, add the "${botRoleName}" role ` +
  `and allow ${listOf(permissions)}, then start the bot again.`;

/**
 * What the bot needs in the server (Connect and Speak for music); Manage Channels is
 * granted on the Users channel only.
 */
const INVITE_PERMISSIONS =
  PermissionFlagsBits.ManageRoles |
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.AddReactions |
  PermissionFlagsBits.Connect |
  PermissionFlagsBits.Speak;

/** The link that adds the bot to a server with those permissions, and with slash commands. */
export const inviteUrl = (applicationId: string) =>
  `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot%20applications.commands&permissions=${INVITE_PERMISSIONS}`;

/** Discord's error, with the fix spelled out for the ones the owner can fix in the server. */
export function describeDiscordError(error: unknown): string {
  if (isDiscordCode(error, RESTJSONErrorCodes.MissingPermissions)) {
    return (
      "Discord refused (Missing Permissions): the bot needs Manage Roles, and its own role " +
      "must sit above this role in Server Settings, Roles"
    );
  }
  if (isDiscordCode(error, RESTJSONErrorCodes.UnknownRole)) {
    return "that role no longer exists: check the role ids in .env";
  }
  return errorMessage(error);
}

/** Discord rate-limits the full member list; between fetches, gateway events keep it current. */
const MEMBER_LIST_MAX_AGE_MS = 60 * 60_000;

export type MemberList = () => Promise<Collection<string, GuildMember>>;

/** Everyone in the server, fetched in full at most hourly (or when some are missing). */
export function createMemberList(guild: Guild): MemberList {
  let fetchedAt = 0;
  return async () => {
    const stale = Date.now() - fetchedAt > MEMBER_LIST_MAX_AGE_MS;
    if (stale || guild.members.cache.size < guild.memberCount) {
      try {
        await guild.members.fetch();
        fetchedAt = Date.now();
      } catch (error) {
        if (!(error instanceof GatewayRateLimitError)) throw error;
        log.warn("Discord is rate-limiting the member list; using the members already known");
      }
    }
    return guild.members.cache;
  };
}
