import { PermissionFlagsBits, type Guild, type GuildTextBasedChannel } from "discord.js";
import { channelFix, isMissingPermission, listOf } from "./discord.ts";
import { errorMessage, log } from "./log.ts";

/**
 * Optional: the day's red and orange folders, posted every morning in the calendar channel
 * (the owner, 2026-10-08). At 06:00 Chicago time, two hours before the New York open, an
 * embed with the date, one line per high (🔴) or medium (🟠) impact event of the day in the
 * chosen currencies, each with its time as a Discord timestamp, so everyone reads it in
 * their own time zone, and a bar colored by the worst of the day. Above it, the alerts role
 * is mentioned when there is one, which is what pings its members: an embed alone never
 * does. The events come from Forex Factory's public weekly feed, the one outside service
 * the bot uses besides Discord and the website (approved by the owner, 2026-10-08).
 *
 * The bot keeps nothing on disk: every minute it looks at the clock, and when the time has
 * come it looks through the channel's messages since then for today's post before making
 * one, so a restart, or a laptop asleep at six, never doubles a post and never loses one
 * (late is still posted). Weekdays always, even to say there is nothing; weekends only when
 * there is something. A feed that cannot be read, or has nothing in it at all, is an error
 * to try again, never a quiet day.
 *
 * The owner plans a "do and don't trade" filter (2026-10-08): `lines` is the place for it.
 */

export const FEED_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
/** When the day's post goes out. Change it here (the README's "Changing things" says so). */
export const POST_AT = { hour: 6, minute: 0, timeZone: "America/Chicago" } as const;
/** How often the clock is looked at; the feed is read once a day. */
export const TICK_MS = 60_000;

const POST_MINUTES = POST_AT.hour * 60 + POST_AT.minute;
const ICONS: ReadonlyMap<string, string> = new Map([
  ["High", "🔴"],
  ["Medium", "🟠"],
]);
/** The embed's bar: red with a red folder, orange with only orange ones, grey on a quiet day. */
const COLORS = { red: 0xed4245, orange: 0xe67e22, quiet: 0x99aab5 };
const NONE = "No red or orange folders today.";
const MAX_LENGTH = 2000;
const MAX_TITLE = 80;
const TIMEOUT_MS = 15_000;
/** The channel is read a page at a time, back to the posting time, and at most this far. */
const PAGE = 100;
const MAX_PAGES = 10;

export type CalendarEvent = { title: string; country: string; impact: string; time: number };

/** A moment on the Chicago clock: the date, minutes since midnight, weekday (0 is Sunday) and the date in words. */
export type Day = { date: string; minutes: number; weekday: number; label: string };

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: POST_AT.timeZone,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
});
const LABEL = new Intl.DateTimeFormat("en-GB", {
  timeZone: POST_AT.timeZone,
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function chicago(time: number): Day {
  const parts = new Map(PARTS.formatToParts(time).map((part) => [part.type, part.value]));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.get(type) ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    minutes: Number(part("hour")) * 60 + Number(part("minute")),
    weekday: WEEKDAYS.indexOf(part("weekday")),
    label: LABEL.format(time),
  };
}

export const postAtLabel = () =>
  `${String(POST_AT.hour).padStart(2, "0")}:${String(POST_AT.minute).padStart(2, "0")} ${POST_AT.timeZone}`;

/**
 * A title as the feed sent it, cut down to letters, digits and a little punctuation, so
 * nothing in it can format the post, link anywhere, mention anyone or add a line. Real
 * titles ("Core CPI m/m", "S&P/CS Composite-20 HPI y/y") come through untouched.
 */
export function cleanTitle(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/:\/\//g, " ")
    .replace(/[^\p{L}\p{N} .,%/&()'+:-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE);
}

/** The feed's entries that make sense, and how many did not. */
export function parseFeed(body: unknown): { events: CalendarEvent[]; skipped: number } {
  if (!Array.isArray(body)) throw new Error("the Forex Factory feed was not a list of events");
  const events: CalendarEvent[] = [];
  let skipped = 0;
  for (const item of body) {
    const event = parseEvent(item);
    if (event) events.push(event);
    else skipped++;
  }
  return { events, skipped };
}

function parseEvent(item: unknown): CalendarEvent | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const { title, country, date, impact } = item as Record<string, unknown>;
  if (typeof title !== "string" || title.length > 200) return undefined;
  if (typeof country !== "string" || !/^[A-Za-z]{2,5}$/.test(country)) return undefined;
  if (typeof impact !== "string" || typeof date !== "string") return undefined;
  const time = Date.parse(date);
  const cleaned = cleanTitle(title);
  if (!Number.isFinite(time) || !cleaned) return undefined;
  return { title: cleaned, country: country.toUpperCase(), impact, time };
}

/** The day's red and orange folders in the chosen currencies, one line each, earliest first. */
export function lines(events: readonly CalendarEvent[], day: Day, currencies: readonly string[]): string[] {
  return events
    .filter((event) => currencies.includes(event.country) && ICONS.has(event.impact) && chicago(event.time).date === day.date)
    .sort((a, b) => a.time - b.time)
    .map((event) => `${ICONS.get(event.impact)} <t:${Math.floor(event.time / 1000)}:t> ${event.title}`);
}

/** What the bot sends: the mention that pings (if any) above an embed holding the day. */
export type CalendarPost = {
  content?: string;
  embeds: [{ title: string; description: string; color: number }];
  allowedMentions: { parse: never[]; roles: string[] };
};

/** The post for the day; `pingRoleId` is the role to mention above the embed. */
export function post(day: Day, eventLines: readonly string[], pingRoleId?: string): CalendarPost {
  const red = eventLines.some((line) => line.startsWith(ICONS.get("High") ?? ""));
  const color = red ? COLORS.red : eventLines.length > 0 ? COLORS.orange : COLORS.quiet;
  return {
    ...(pingRoleId ? { content: `<@&${pingRoleId}>` } : {}),
    embeds: [{ title: day.label, description: fit(eventLines), color }],
    allowedMentions: { parse: [], roles: pingRoleId ? [pingRoleId] : [] },
  };
}

/** The lines, cut to Discord's length with a count of what was left out. */
function fit(eventLines: readonly string[]): string {
  if (eventLines.length === 0) return NONE;
  const shown = [...eventLines];
  for (;;) {
    const left = eventLines.length - shown.length;
    const text = [...shown, ...(left > 0 ? [`… and ${left} more`] : [])].join("\n");
    if (text.length <= MAX_LENGTH || shown.length === 0) return text;
    shown.pop();
  }
}

/** The little of a message, and of a text channel, that the calendar needs; discord.js's fit. */
export type RecentMessage = {
  id: string;
  createdTimestamp: number;
  author: { id: string };
  content: string;
  embeds: readonly { title?: string | null }[];
};

export type CalendarChannel = {
  name: string;
  messages: { fetch(options: { limit: number; before?: string }): Promise<{ values(): Iterable<RecentMessage> }> };
  send(message: CalendarPost): Promise<unknown>;
};

/** Today's post: the embed titled with the day (or, from before embeds, a text starting with it in bold). */
const isTodays = (message: RecentMessage, day: Day) =>
  message.embeds.some((embed) => embed.title === day.label) || message.content.startsWith(`**${day.label}**`);

type Options = { fetch?: typeof fetch; now?: () => number; pingRoleId?: string };

export function createCalendar(
  channel: CalendarChannel,
  botId: string,
  currencies: readonly string[],
  { fetch: fetchImpl = fetch, now = Date.now, pingRoleId }: Options = {},
) {
  /** The Chicago date of the last post made or found, so the channel is searched once a day. */
  let postedFor: string | undefined;
  const needed = `the bot needs View Channel, Send Messages and Read Message History in #${channel.name}`;

  /** Whether today's post is in the channel: its messages since the posting time, newest first. */
  async function postedToday(day: Day, since: number): Promise<boolean> {
    let before: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const messages = [...(await channel.messages.fetch({ limit: PAGE, before })).values()];
      if (messages.some((message) => message.author.id === botId && isTodays(message, day))) return true;
      const oldest = messages.reduce<RecentMessage | undefined>(
        (found, message) => (!found || message.createdTimestamp < found.createdTimestamp ? message : found),
        undefined,
      );
      if (!oldest || messages.length < PAGE || oldest.createdTimestamp < since) return false;
      before = oldest.id;
    }
    return false;
  }

  return {
    /** Once a minute: posts the day's folders when the time has come and nothing is posted yet. */
    async tick(): Promise<void> {
      const moment = now();
      const day = chicago(moment);
      if (postedFor === day.date || day.minutes < POST_MINUTES) return;
      // Today's post can only be from the posting time on (a minute's margin for the clock).
      const since = moment - (day.minutes - POST_MINUTES + 1) * 60_000;
      try {
        if (await postedToday(day, since)) {
          postedFor = day.date;
          return;
        }
      } catch (error) {
        throw new Error(isMissingPermission(error) ? needed : errorMessage(error));
      }
      const todaysLines = lines(await readFeed(fetchImpl), day, currencies);
      const weekend = day.weekday === 0 || day.weekday === 6;
      if (todaysLines.length === 0 && weekend) {
        postedFor = day.date;
        return;
      }
      try {
        await channel.send(post(day, todaysLines, pingRoleId));
      } catch (error) {
        throw new Error(isMissingPermission(error) ? needed : errorMessage(error));
      }
      postedFor = day.date;
      log.info(`posted the day's calendar in #${channel.name}: ${todaysLines.length} event(s)`);
    },
  };
}

async function readFeed(fetchImpl: typeof fetch): Promise<CalendarEvent[]> {
  const response = await fetchImpl(FEED_URL, {
    headers: { accept: "application/json", "user-agent": "AgentZero (ZeroCorps Discord bot)" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Forex Factory answered HTTP ${response.status} for the calendar feed`);
  const { events, skipped } = parseFeed(await response.json().catch(() => undefined));
  // The week's feed always holds something; nothing readable means the feed changed, not a quiet week.
  if (events.length === 0) throw new Error("the Forex Factory feed had no events the bot could read");
  if (skipped > 0) log.warn(`${skipped} entr${skipped === 1 ? "y" : "ies"} of the Forex Factory feed made no sense and were left out`);
  return events;
}

const NEEDED_IN_CHANNEL = {
  "View Channel": PermissionFlagsBits.ViewChannel,
  "Send Messages": PermissionFlagsBits.SendMessages,
  "Read Message History": PermissionFlagsBits.ReadMessageHistory,
};

/**
 * The calendar channel, checked once at start. A channel that does not exist switches the
 * calendar off; missing permissions only warn, so fixing them in Discord needs no restart.
 */
export async function openCalendarChannel(guild: Guild, channelId: string): Promise<GuildTextBasedChannel | undefined> {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) {
    log.warn("CALENDAR_CHANNEL_ID names no text channel in the server: the calendar is off");
    return undefined;
  }
  const me = await guild.members.fetchMe();
  const permissions = channel.permissionsFor(me);
  const missing = Object.entries(NEEDED_IN_CHANNEL)
    .filter(([, flag]) => !permissions.has(flag))
    .map(([name]) => name);
  if (missing.length > 0) {
    log.warn(
      `the bot cannot post the calendar in #${channel.name} (CALENDAR_CHANNEL_ID): it lacks ${listOf(missing)}. ` +
        channelFix(channel.name, me.roles.botRole?.name ?? me.displayName, Object.keys(NEEDED_IN_CHANNEL)),
    );
  }
  return channel;
}

/**
 * Whether the morning post can ping the role: Discord only delivers a role mention from a
 * bot that may mention every role in the channel, or for a role anyone may mention. Warns
 * once at start; fixing it in Discord needs no restart.
 */
export async function checkPing(guild: Guild, channel: GuildTextBasedChannel, roleId: string): Promise<void> {
  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role) return;
  const me = await guild.members.fetchMe();
  if (role.mentionable || channel.permissionsFor(me).has(PermissionFlagsBits.MentionEveryone)) return;
  log.warn(
    `the morning calendar cannot ping @${role.name}: in Discord, right-click #${channel.name}, Edit Channel, ` +
      `Permissions, and allow the bot's role "Mention @everyone, @here and All Roles"; or make @${role.name} ` +
      "mentionable in Server Settings, Roles",
  );
}
