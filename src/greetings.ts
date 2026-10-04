import { PermissionFlagsBits, type Guild, type GuildTextBasedChannel } from "discord.js";
import { channelFix } from "./discord.ts";
import { log } from "./log.ts";

/**
 * The greetings: "Welcome @user!" in the welcome channel when someone joins, and "Seeya
 * @user!" in the goodbye channel when someone leaves, is kicked or is banned (Discord reports
 * all three as one event). Each channel is optional, and neither is ever the verify channel:
 * the owner keeps the three apart.
 */

/** Posted when someone joins; the mention pings them. Edit the words here. */
export const greeting = (memberId: string) => `Welcome <@${memberId}>!`;

/** Posted when someone has left. They are gone, so the mention pings no one. */
export const farewell = (memberId: string) => `Seeya <@${memberId}>!`;

/**
 * A greeting channel, checked once at start. A channel that does not exist switches that
 * greeting off; missing permissions only warn, so fixing them in Discord needs no restart.
 */
export async function openGreetingChannel(
  guild: Guild,
  channelId: string,
  variable: string,
): Promise<GuildTextBasedChannel | undefined> {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) {
    log.warn(`${variable} names no text channel in the server: those greetings are off`);
    return undefined;
  }
  const me = await guild.members.fetchMe();
  if (!channel.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    log.warn(
      `the bot cannot post in #${channel.name} (${variable}), so those greetings will fail. ` +
        channelFix(channel.name, me.roles.botRole?.name ?? me.displayName, ["View Channel", "Send Messages"]),
    );
  }
  return channel;
}
