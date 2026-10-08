import { RateLimitError, RESTJSONErrorCodes } from "discord.js";
import { isDiscordCode, isMissingPermission } from "./discord.ts";
import { errorMessage, log } from "./log.ts";

/**
 * Optional: a channel named "Users: N", where N is how many ZeroCorps accounts there are:
 * the website's own count (`GET /api/internal/stats`), accounts that are email-verified and
 * have chosen a username. index.ts asks the website every few minutes and passes the count
 * here. Discord allows two renames of a channel in ten minutes: the bot renames at most once
 * every five, and only when the count changed. A rename over Discord's limit (after quick
 * restarts, or a rename by hand) fails at once rather than waiting (index.ts sets that up);
 * like any failure here, it is logged and tried again.
 */

const MIN_RENAME_GAP_MS = 5 * 60_000;

export const usersName = (count: number) => `Users: ${count}`;

/** The little of a server that renaming one channel needs; a discord.js Guild fits. */
export type ChannelSource = {
  channels: {
    fetch(id: string): Promise<{ name: string; setName(name: string, reason?: string): Promise<unknown> } | null>;
  };
};

export function createUsersChannel(guild: ChannelSource, channelId: string, now: () => number = Date.now) {
  let lastRenameAt = -Infinity;
  return {
    /** Puts `count` in the channel's name, unless it is there already or a rename was tried in the last five minutes. */
    async show(count: number): Promise<void> {
      if (now() - lastRenameAt < MIN_RENAME_GAP_MS) return;
      let channelName = "the STATS_CHANNEL_ID channel";
      try {
        const channel = await guild.channels.fetch(channelId);
        const name = usersName(count);
        if (!channel || channel.name === name) return;
        channelName = `"${channel.name}"`;
        lastRenameAt = now();
        await channel.setName(name, "ZeroCorps accounts, from zerocorps.org");
        log.info(`renamed the channel to "${name}"`);
      } catch (error) {
        const reason =
          error instanceof RateLimitError
            ? "Discord allows only two renames of a channel in ten minutes; trying again in five"
            : isMissingPermission(error)
              ? `the bot needs View Channel and Manage Channels on ${channelName}. In Discord: right-click it, ` +
                "Edit Channel, Permissions, add the bot's role and allow both; the bot tries again in five minutes"
              : isDiscordCode(error, RESTJSONErrorCodes.UnknownChannel)
                ? "STATS_CHANNEL_ID names no channel in the server"
                : errorMessage(error);
        log.error(`could not update the Users channel: ${reason}`);
      }
    },
  };
}
