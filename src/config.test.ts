import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, readConfig } from "./config.ts";

const SECRET = "test-secret-that-is-at-least-32-characters-long";

const valid = {
  DISCORD_TOKEN: "token-value",
  GUILD_ID: "100000000000000000",
  VERIFIED_ROLE_ID: "200000000000000000",
  BRONZE_ROLE_ID: "300000000000000000",
  VERIFY_CHANNEL_ID: "400000000000000000",
  ZEROCORPS_API_URL: "https://zerocorps.org/",
  INTERNAL_API_SECRET: SECRET,
};

function problemsWith(env: Record<string, string | undefined>): string {
  try {
    readConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error.message;
  }
  assert.fail("expected the settings to be refused");
}

describe("readConfig", () => {
  it("reads a complete .env", () => {
    const config = readConfig(valid);
    assert.equal(config.apiOrigin, "https://zerocorps.org");
    assert.deepEqual([...config.rankRoles], [["bronze", "300000000000000000"]]);
    assert.equal(config.syncIntervalMs, 5 * 60_000);
    assert.equal(config.verifyChannelId, "400000000000000000");
    assert.equal(config.welcomeChannelId, undefined);
    assert.equal(config.goodbyeChannelId, undefined);
    assert.equal(config.statsChannelId, undefined);
    assert.equal(config.calendarChannelId, undefined);
    assert.deepEqual(config.calendarCurrencies, ["USD"]);
    assert.equal(config.alertsChannelId, undefined);
    assert.equal(config.alertsRoleId, undefined);
    assert.equal(config.commandsChannelId, undefined);
  });

  it("reads the music channel, which may not be the verify channel", () => {
    assert.equal(readConfig({ ...valid, COMMANDS_CHANNEL_ID: "920000000000000000" }).commandsChannelId, "920000000000000000");
    assert.match(problemsWith({ ...valid, COMMANDS_CHANNEL_ID: valid.VERIFY_CHANNEL_ID }), /COMMANDS_CHANNEL_ID is the verify channel/);
  });

  it("reads the alerts message settings, both or neither", () => {
    const alerts = { ALERTS_CHANNEL_ID: "900000000000000000", ALERTS_ROLE_ID: "910000000000000000" };
    const config = readConfig({ ...valid, ...alerts });
    assert.equal(config.alertsChannelId, alerts.ALERTS_CHANNEL_ID);
    assert.equal(config.alertsRoleId, alerts.ALERTS_ROLE_ID);
    assert.match(problemsWith({ ...valid, ALERTS_CHANNEL_ID: alerts.ALERTS_CHANNEL_ID }), /go together/);
    assert.match(problemsWith({ ...valid, ALERTS_ROLE_ID: alerts.ALERTS_ROLE_ID }), /go together/);
    assert.match(problemsWith({ ...valid, ...alerts, ALERTS_ROLE_ID: valid.VERIFIED_ROLE_ID }), /must not be the verified role/);
    assert.match(problemsWith({ ...valid, ...alerts, ALERTS_ROLE_ID: valid.BRONZE_ROLE_ID }), /must not be a rank role/);
    assert.match(problemsWith({ ...valid, ...alerts, ALERTS_CHANNEL_ID: valid.VERIFY_CHANNEL_ID }), /ALERTS_CHANNEL_ID is the verify channel/);
  });

  it("reads the calendar settings", () => {
    const config = readConfig({ ...valid, CALENDAR_CHANNEL_ID: "800000000000000000", CALENDAR_CURRENCIES: " usd, eur " });
    assert.equal(config.calendarChannelId, "800000000000000000");
    assert.deepEqual(config.calendarCurrencies, ["USD", "EUR"]);
    assert.match(problemsWith({ ...valid, CALENDAR_CURRENCIES: "dollars" }), /CALENDAR_CURRENCIES must be currency codes/);
    assert.match(problemsWith({ ...valid, CALENDAR_CHANNEL_ID: valid.VERIFY_CHANNEL_ID }), /CALENDAR_CHANNEL_ID is the verify channel/);
  });

  it("reads the optional settings", () => {
    const config = readConfig({
      ...valid,
      SYNC_INTERVAL_MINUTES: "2",
      STATS_CHANNEL_ID: "500000000000000000",
      WELCOME_CHANNEL_ID: "600000000000000000",
      GOODBYE_CHANNEL_ID: "700000000000000000",
    });
    assert.equal(config.syncIntervalMs, 2 * 60_000);
    assert.equal(config.statsChannelId, "500000000000000000");
    assert.equal(config.welcomeChannelId, "600000000000000000");
    assert.equal(config.goodbyeChannelId, "700000000000000000");
  });

  it("accepts ROOKIE_ROLE_ID as the earlier name of BRONZE_ROLE_ID", () => {
    const { BRONZE_ROLE_ID: bronze, ...withoutBronze } = valid;
    const older = readConfig({ ...withoutBronze, ROOKIE_ROLE_ID: bronze });
    assert.deepEqual([...older.rankRoles], [["bronze", bronze]]);
    // Both set: the current name wins.
    const both = readConfig({ ...valid, ROOKIE_ROLE_ID: "310000000000000000" });
    assert.deepEqual([...both.rankRoles], [["bronze", bronze]]);
  });

  it("keeps greetings out of the verify channel", () => {
    const sameWelcome = problemsWith({ ...valid, WELCOME_CHANNEL_ID: valid.VERIFY_CHANNEL_ID });
    assert.match(sameWelcome, /WELCOME_CHANNEL_ID is the verify channel/);
    const sameGoodbye = problemsWith({ ...valid, GOODBYE_CHANNEL_ID: valid.VERIFY_CHANNEL_ID });
    assert.match(sameGoodbye, /GOODBYE_CHANNEL_ID is the verify channel/);
    // Welcome and goodbye may share a channel.
    const shared = { WELCOME_CHANNEL_ID: "600000000000000000", GOODBYE_CHANNEL_ID: "600000000000000000" };
    assert.equal(readConfig({ ...valid, ...shared }).goodbyeChannelId, "600000000000000000");
  });

  it("tells an old .env where the verify channel went", () => {
    const { VERIFY_CHANNEL_ID: _moved, ...old } = valid;
    const message = problemsWith({ ...old, WELCOME_CHANNEL_ID: "400000000000000000" });
    assert.match(message, /VERIFY_CHANNEL_ID is not set/);
    assert.match(message, /WELCOME_CHANNEL_ID is now the channel for join greetings/);
  });

  it("names every missing variable at once", () => {
    const message = problemsWith({});
    for (const name of [
      "DISCORD_TOKEN",
      "GUILD_ID",
      "VERIFIED_ROLE_ID",
      "BRONZE_ROLE_ID",
      "VERIFY_CHANNEL_ID",
      "ZEROCORPS_API_URL",
      "INTERNAL_API_SECRET",
    ]) {
      assert.match(message, new RegExp(`${name} is not set`));
    }
  });

  it("refuses a short secret without printing it", () => {
    const message = problemsWith({ ...valid, INTERNAL_API_SECRET: "short-secret-value" });
    assert.match(message, /shorter than 32/);
    assert.ok(!message.includes("short-secret-value"));
  });

  it("refuses a secret with a line break or control character, without printing it", () => {
    for (const bad of [`${SECRET}\nsecond-line`, `${SECRET}\u0000`, `half\t${SECRET}`]) {
      const message = problemsWith({ ...valid, INTERNAL_API_SECRET: bad });
      assert.match(message, /one line of plain characters/);
      assert.ok(!message.includes(SECRET));
    }
  });

  it("refuses a token or secret value from ever reaching the message", () => {
    const message = problemsWith({ ...valid, GUILD_ID: "nope" });
    assert.ok(!message.includes("token-value"));
    assert.ok(!message.includes(SECRET));
  });

  it("sends the secret to the live website over HTTPS only, never to this machine", () => {
    assert.match(problemsWith({ ...valid, ZEROCORPS_API_URL: "http://zerocorps.org" }), /must start with https/);
    for (const local of [
      "http://localhost:3000",
      "https://localhost:3000",
      "https://LOCALHOST./",
      "https://app.localhost",
      "https://127.0.0.1",
      "https://127.1:3000",
      "https://[::1]:3000",
      "https://[::ffff:127.0.0.1]",
      "https://0.0.0.0",
    ]) {
      assert.match(problemsWith({ ...valid, ZEROCORPS_API_URL: local }), /never this machine/, local);
    }
    // Real addresses that merely contain "localhost" or "127" are still accepted.
    for (const site of ["https://notlocalhost.example", "https://127example.org", "https://zerocorps.org"]) {
      assert.equal(readConfig({ ...valid, ZEROCORPS_API_URL: site }).apiOrigin, new URL(site).origin, site);
    }
  });

  it("refuses ids that are not Discord ids", () => {
    assert.match(problemsWith({ ...valid, BRONZE_ROLE_ID: "@Bronze" }), /BRONZE_ROLE_ID is not a Discord id/);
  });

  it("refuses the verified role as a rank role", () => {
    const message = problemsWith({ ...valid, VERIFIED_ROLE_ID: valid.BRONZE_ROLE_ID });
    assert.match(message, /VERIFIED_ROLE_ID must not be a rank role/);
  });

  it("refuses a sync interval outside 1 to 60 minutes", () => {
    assert.match(problemsWith({ ...valid, SYNC_INTERVAL_MINUTES: "0" }), /SYNC_INTERVAL_MINUTES/);
    assert.match(problemsWith({ ...valid, SYNC_INTERVAL_MINUTES: "every so often" }), /SYNC_INTERVAL_MINUTES/);
  });
});
