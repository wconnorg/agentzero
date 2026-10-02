// npm run discord:check
//
// Asks Discord which application DISCORD_TOKEN belongs to, what that application has
// switched on, and which servers the bot is in, without ever showing the token. For
// "Discord refused the Server Members intent" while the portal shows the intent on (the
// token is then from another application, or the switch was never saved), and for "the
// bot is not in the server GUILD_ID names" (not invited yet, or a wrong GUILD_ID).

import { ApplicationFlags, Routes } from "discord.js";
import { SNOWFLAKE } from "../src/config.ts";
import { inviteUrl } from "../src/discord.ts";

const API = "https://discord.com/api/v10";
const token = process.env.DISCORD_TOKEN?.trim();
const guildId = process.env.GUILD_ID?.trim();

if (!token) {
  console.error("DISCORD_TOKEN is not set in .env.");
  process.exit(1);
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(API + path, {
    headers: { authorization: `Bot ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

const field = (body: unknown, key: string): unknown =>
  typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined;

const app = await get(Routes.currentApplication());
if (app.status === 401) {
  console.log("Discord refused DISCORD_TOKEN: it is not a valid bot token.");
  console.log("Copy a new one from the Bot tab of Agent Zero's application (Reset Token) into .env.");
  process.exit(1);
}
if (app.status !== 200) {
  console.log(`Discord answered HTTP ${app.status} when asked about the application; try again shortly.`);
  process.exit(1);
}

const appId = String(field(app.body, "id"));
const flags = Number(field(app.body, "flags") ?? 0);
const has = (...bits: number[]) => bits.some((bit) => (flags & bit) !== 0);
const serverMembers = has(ApplicationFlags.GatewayGuildMembers, ApplicationFlags.GatewayGuildMembersLimited);

console.log(`DISCORD_TOKEN belongs to the application "${String(field(app.body, "name"))}" (id ${appId}).`);
console.log(`  Server Members Intent:  ${serverMembers ? "ON" : "OFF  <- the bot needs this on"}`);
console.log(
  `  Message Content Intent: ${has(ApplicationFlags.GatewayMessageContent, ApplicationFlags.GatewayMessageContentLimited) ? "on" : "off"} (not needed)`,
);
console.log(
  `  Presence Intent:        ${has(ApplicationFlags.GatewayPresence, ApplicationFlags.GatewayPresenceLimited) ? "on" : "off"} (not needed)`,
);
console.log(`  Public Bot:             ${field(app.body, "bot_public") ? "on  <- switch it off" : "off"}`);

let inServer = false;
if (guildId && SNOWFLAKE.test(guildId)) {
  const guild = await get(Routes.guild(guildId));
  inServer = guild.status === 200;
  console.log(
    inServer
      ? `  In the server:          yes, "${String(field(guild.body, "name"))}" (GUILD_ID)`
      : `  In the server:          no (HTTP ${guild.status})`,
  );
} else {
  console.log("  In the server:          GUILD_ID is not set to a Discord id");
}

if (!inServer) {
  const mine = await get(Routes.userGuilds());
  const servers = Array.isArray(mine.body)
    ? mine.body.map((server: unknown) => `"${String(field(server, "name"))}" (${String(field(server, "id"))})`)
    : [];
  console.log(`  The bot is in:          ${servers.length > 0 ? servers.join(", ") : "no server yet"}`);
}

const next: string[] = [];
if (!serverMembers) {
  next.push(
    "Open this application's Bot page, switch Server Members Intent on and click Save Changes:\n" +
      `  https://discord.com/developers/applications/${appId}/bot\n` +
      "If that is not the application you switched it on in, the token in .env is from another one.",
  );
}
if (!inServer) {
  next.push(
    "If the ZeroCorps server is listed above, put its id in GUILD_ID. Otherwise invite the bot:\n" +
      `  ${inviteUrl(appId)}`,
  );
}
console.log(next.length > 0 ? `\n${next.join("\n\n")}` : "\nAll set: start the bot with npm start.");
