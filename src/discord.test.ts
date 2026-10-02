import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inviteUrl } from "./discord.ts";

describe("inviteUrl", () => {
  it("invites the bot with exactly the permissions the README lists", () => {
    const url = new URL(inviteUrl("1234567890123456789"));
    assert.equal(url.origin + url.pathname, "https://discord.com/oauth2/authorize");
    assert.equal(url.searchParams.get("client_id"), "1234567890123456789");
    assert.equal(url.searchParams.get("scope"), "bot");
    // Manage Roles, View Channels, Send Messages, Read Message History, Add Reactions.
    assert.equal(url.searchParams.get("permissions"), "268504128");
  });
});
