import { RateLimitError, RESTJSONErrorCodes, type Guild } from "discord.js";
import { isDiscordCode, isMissingPermission } from "./discord.ts";
import { errorMessage, log } from "./log.ts";

/**
 * Optional: a channel named "Academy Users: N", where N is how many Discord accounts are
 * linked on the website. The count comes with each rank sync, so it costs no call of its
 * own. Discord allows two renames of a channel in ten minutes: the bot renames at most once
 * every five, and only when the count changed. A rename over Discord's limit (after quick
 * restarts, or a rename by hand) fails at once rather than waiting (index.ts sets that up),
 * so it never holds up the rank sync; like any failure here, it is logged and tried again.
 */

const MIN_RENAME_GAP_MS = 5 * 60_000;

export const academyUsersName = (count: number) => `Academy Users: ${count}`;

export function createAcademyUsersChannel(guild: Guild, channelId: string) {
  let lastRenameAt = 0;
  return {
    async show(count: number): Promise<void> {
      if (Date.now() - lastRenameAt < MIN_RENAME_GAP_MS) return;
      try {
        const channel = await guild.channels.fetch(channelId);
        const name = academyUsersName(count);
        if (!channel || channel.name === name) return;
        lastRenameAt = Date.now();
        await channel.setName(name, "Linked Discord accounts on zerocorps.org");
        log.info(`renamed the channel to "${name}"`);
      } catch (error) {
        const reason =
          error instanceof RateLimitError
            ? "Discord allows only two renames of a channel in ten minutes; trying again in five"
            : isMissingPermission(error)
              ? "the bot needs Manage Channels on that channel"
              : isDiscordCode(error, RESTJSONErrorCodes.UnknownChannel)
                ? "STATS_CHANNEL_ID names no channel in the server"
                : errorMessage(error);
        log.error(`could not update the Academy Users channel: ${reason}`);
      }
    },
  };
}
