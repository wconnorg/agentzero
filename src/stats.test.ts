import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DiscordAPIError, RESTJSONErrorCodes } from "discord.js";
import { log } from "./log.ts";
import { createUsersChannel, usersName } from "./stats.ts";

const ID = "500000000000000000";
const FIVE_MINUTES = 5 * 60_000;

/** A server with one renamable channel; `fail` makes every rename throw. */
function fakeGuild(name: string, fail?: () => Error) {
  const renames: string[] = [];
  const channel = {
    name,
    async setName(next: string) {
      if (fail) throw fail();
      channel.name = next;
      renames.push(next);
      return channel;
    },
  };
  const guild = { channels: { fetch: async (id: string) => (id === ID ? channel : null) } };
  return { guild, channel, renames };
}

/** What discord.js throws when a channel id names nothing (deleted, or never there). */
const unknownChannel = () =>
  new DiscordAPIError(
    { code: RESTJSONErrorCodes.UnknownChannel, message: "Unknown Channel" },
    RESTJSONErrorCodes.UnknownChannel,
    404,
    "GET",
    `https://discord.com/api/v10/channels/${ID}`,
    {},
  );

describe("the Users channel", () => {
  it("names the channel after the count, and only renames when it changed", async (t) => {
    t.mock.method(log, "info", () => {});
    let clock = 0;
    const { guild, channel, renames } = fakeGuild("Academy Users: 1");
    const users = createUsersChannel(guild, ID, () => clock);
    await users.show(3);
    assert.equal(channel.name, usersName(3));
    clock += FIVE_MINUTES;
    await users.show(3);
    assert.deepEqual(renames, ["Users: 3"]);
  });

  it("renames at most once in five minutes", async (t) => {
    t.mock.method(log, "info", () => {});
    let clock = 0;
    const { guild, renames } = fakeGuild("Users: 0");
    const users = createUsersChannel(guild, ID, () => clock);
    await users.show(1);
    clock += FIVE_MINUTES - 1;
    await users.show(2);
    assert.deepEqual(renames, ["Users: 1"]);
    clock += 1;
    await users.show(2);
    assert.deepEqual(renames, ["Users: 1", "Users: 2"]);
  });

  it("logs a failed rename instead of throwing, and waits five minutes before trying again", async (t) => {
    const errors = t.mock.method(log, "error", () => {});
    let clock = 0;
    let attempts = 0;
    const { guild } = fakeGuild("Users: 0", () => {
      attempts++;
      return new Error("Discord said no");
    });
    const users = createUsersChannel(guild, ID, () => clock);
    await users.show(1);
    await users.show(1);
    assert.equal(attempts, 1);
    assert.equal(errors.mock.callCount(), 1);
    assert.match(String(errors.mock.calls[0]?.arguments[0]), /could not update the Users channel: Discord said no/);
    clock += FIVE_MINUTES;
    await users.show(1);
    assert.equal(attempts, 2);
  });

  it("says so when the channel no longer exists, without throwing", async (t) => {
    const errors = t.mock.method(log, "error", () => {});
    const guild = {
      channels: {
        fetch: async () => {
          throw unknownChannel();
        },
      },
    };
    const users = createUsersChannel(guild, ID, () => 0);
    await users.show(1);
    assert.match(String(errors.mock.calls[0]?.arguments[0]), /STATS_CHANNEL_ID names no channel in the server/);
  });
});
