/**
 * Agent Zero's settings, read from the environment (`.env` locally) and checked once at
 * start. A problem stops the bot with every broken variable named, never with a value
 * printed: the token and the secret must never reach a log.
 */

export const SNOWFLAKE = /^\d{17,20}$/;

/**
 * The website's rank keys and the variable holding each one's Discord role. A new rank
 * on the website is one line here and one variable in `.env`.
 */
const RANK_ROLE_VARIABLES = {
  bronze: "BRONZE_ROLE_ID",
} as const;

/**
 * Earlier names of the same variables, still accepted: the first rank was called Rookie
 * until 2026-10-05, when the website renamed it Bronze, and the Discord role kept its id.
 */
const EARLIER_NAMES: Readonly<Record<string, string>> = {
  BRONZE_ROLE_ID: "ROOKIE_ROLE_ID",
};

export type Config = {
  discordToken: string;
  guildId: string;
  verifiedRoleId: string;
  /** The channel of the verify message, the one members react to with ✅. */
  verifyChannelId: string;
  /** Optional: where "Welcome @user!" goes when someone joins. */
  welcomeChannelId: string | undefined;
  /** Optional: where "Seeya @user!" goes when someone leaves, is kicked or is banned. */
  goodbyeChannelId: string | undefined;
  /** Rank key (from the website) -> the Discord role id for that rank. */
  rankRoles: ReadonlyMap<string, string>;
  /** The website's origin, e.g. `https://zerocorps.org`. */
  apiOrigin: string;
  apiSecret: string;
  syncIntervalMs: number;
  /** Optional: the channel whose name shows how many ZeroCorps accounts there are. */
  statsChannelId: string | undefined;
  /** Optional: where the day's red and orange folders go each morning. */
  calendarChannelId: string | undefined;
  /** The currencies the calendar covers, e.g. ["USD"]. */
  calendarCurrencies: readonly string[];
  /** Optional, together: the channel of the alerts message, and the role a 🔔 on it gives. */
  alertsChannelId: string | undefined;
  alertsRoleId: string | undefined;
};

const DEFAULT_CALENDAR_CURRENCIES: readonly string[] = ["USD"];

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function readConfig(env: Record<string, string | undefined>): Config {
  const problems: string[] = [];
  const read = (name: string) => {
    const earlier = EARLIER_NAMES[name];
    return env[name]?.trim() || (earlier ? env[earlier]?.trim() : undefined) || "";
  };

  const required = (name: string) => {
    const value = read(name);
    if (!value) problems.push(`${name} is not set`);
    return value;
  };
  const snowflake = (name: string) => {
    const value = required(name);
    if (value && !SNOWFLAKE.test(value)) problems.push(`${name} is not a Discord id (17 to 20 digits)`);
    return value;
  };
  const optionalSnowflake = (name: string) => {
    const value = read(name);
    if (value && !SNOWFLAKE.test(value)) problems.push(`${name} is not a Discord id (17 to 20 digits)`);
    return value || undefined;
  };

  const discordToken = required("DISCORD_TOKEN");
  const guildId = snowflake("GUILD_ID");
  const verifiedRoleId = snowflake("VERIFIED_ROLE_ID");

  const verifyChannelId = read("VERIFY_CHANNEL_ID");
  if (!verifyChannelId) {
    problems.push(
      "VERIFY_CHANNEL_ID is not set: the channel of the ✅ verify message " +
        "(WELCOME_CHANNEL_ID is now the channel for join greetings)",
    );
  } else if (!SNOWFLAKE.test(verifyChannelId)) {
    problems.push("VERIFY_CHANNEL_ID is not a Discord id (17 to 20 digits)");
  }
  const welcomeChannelId = optionalSnowflake("WELCOME_CHANNEL_ID");
  const goodbyeChannelId = optionalSnowflake("GOODBYE_CHANNEL_ID");
  const calendarChannelId = optionalSnowflake("CALENDAR_CHANNEL_ID");
  const alertsChannelId = optionalSnowflake("ALERTS_CHANNEL_ID");
  // Anything else posted there would bury the verify message (the owner keeps the channels apart).
  for (const [name, id] of [
    ["WELCOME_CHANNEL_ID", welcomeChannelId],
    ["GOODBYE_CHANNEL_ID", goodbyeChannelId],
    ["CALENDAR_CHANNEL_ID", calendarChannelId],
    ["ALERTS_CHANNEL_ID", alertsChannelId],
  ] as const) {
    if (id && id === verifyChannelId) {
      problems.push(`${name} is the verify channel, which holds the verify message only`);
    }
  }

  const currenciesText = read("CALENDAR_CURRENCIES");
  const calendarCurrencies = currenciesText
    ? currenciesText.split(",").map((code) => code.trim().toUpperCase()).filter(Boolean)
    : DEFAULT_CALENDAR_CURRENCIES;
  if (calendarCurrencies.some((code) => !/^[A-Z]{2,5}$/.test(code))) {
    problems.push("CALENDAR_CURRENCIES must be currency codes separated by commas, e.g. USD,EUR");
  }

  const rankRoles = new Map<string, string>();
  for (const [rank, variable] of Object.entries(RANK_ROLE_VARIABLES)) {
    rankRoles.set(rank, snowflake(variable));
  }
  const rankRoleIds = [...rankRoles.values()];
  if (verifiedRoleId && rankRoleIds.includes(verifiedRoleId)) {
    problems.push("VERIFIED_ROLE_ID must not be a rank role: the rank sync would take it away");
  }
  if (new Set(rankRoleIds).size !== rankRoleIds.length) {
    problems.push("two ranks share the same role id");
  }

  const alertsRoleId = optionalSnowflake("ALERTS_ROLE_ID");
  if (Boolean(alertsChannelId) !== Boolean(alertsRoleId)) {
    problems.push("ALERTS_CHANNEL_ID and ALERTS_ROLE_ID go together: set both, or neither");
  }
  if (alertsRoleId && alertsRoleId === verifiedRoleId) {
    problems.push("ALERTS_ROLE_ID must not be the verified role");
  }
  if (alertsRoleId && rankRoleIds.includes(alertsRoleId)) {
    problems.push("ALERTS_ROLE_ID must not be a rank role: the rank sync would take it away");
  }

  const apiOrigin = websiteOrigin(required("ZEROCORPS_API_URL"), problems);

  const apiSecret = required("INTERNAL_API_SECRET");
  if (apiSecret && apiSecret.length < 32) {
    problems.push("INTERNAL_API_SECRET is shorter than 32 characters (the website refuses it)");
  }
  // A header value cannot hold a line break or control character, and fetch's error for one
  // would quote the secret. `npm run secret:new` makes letters, digits, - and _ only.
  if (apiSecret && !/^[\x20-\x7E]+$/.test(apiSecret)) {
    problems.push("INTERNAL_API_SECRET must be one line of plain characters (no line breaks or tabs)");
  }

  let syncMinutes = 5;
  const syncText = read("SYNC_INTERVAL_MINUTES");
  if (syncText) {
    syncMinutes = Number(syncText);
    if (!Number.isInteger(syncMinutes) || syncMinutes < 1 || syncMinutes > 60) {
      problems.push("SYNC_INTERVAL_MINUTES must be a whole number from 1 to 60");
    }
  }

  const statsChannelId = optionalSnowflake("STATS_CHANNEL_ID");

  if (problems.length > 0) {
    throw new ConfigError(`Agent Zero's settings need fixing:\n  - ${problems.join("\n  - ")}`);
  }
  return {
    discordToken,
    guildId,
    verifiedRoleId,
    verifyChannelId,
    welcomeChannelId,
    goodbyeChannelId,
    rankRoles,
    apiOrigin,
    apiSecret,
    syncIntervalMs: syncMinutes * 60_000,
    statsChannelId,
    calendarChannelId,
    calendarCurrencies,
    alertsChannelId,
    alertsRoleId,
  };
}

/** localhost, its subdomains, 127.x.x.x, [::1] (also as mapped 127.x) and 0.0.0.0, as the URL parser writes them. */
const THIS_MACHINE = /(^|\.)localhost\.?$|^127\.|^\[::1\]$|^\[::ffff:7f|^0\.0\.0\.0$/i;

/**
 * The secret travels only over HTTPS, and only to the live website: the internal API is
 * off on the laptop, whose port 3000 is the website's dev server (the owner, 2026-09-29).
 */
function websiteOrigin(text: string, problems: string[]): string {
  if (!text) return "";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    problems.push("ZEROCORPS_API_URL is not a web address");
    return "";
  }
  if (url.protocol !== "https:") problems.push("ZEROCORPS_API_URL must start with https://");
  if (THIS_MACHINE.test(url.hostname)) {
    problems.push("ZEROCORPS_API_URL must be the live website (https://zerocorps.org), never this machine");
  }
  if (url.username || url.password) problems.push("ZEROCORPS_API_URL must not contain a login");
  return url.origin;
}
