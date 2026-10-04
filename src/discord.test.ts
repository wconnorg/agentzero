import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { channelFix, inviteUrl, listOf } from "./discord.ts";

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

describe("the permission advice", () => {
  it("lists permissions the way a person would", () => {
    assert.equal(listOf([]), "");
    assert.equal(listOf(["View Channel"]), "View Channel");
    assert.equal(listOf(["View Channel", "Send Messages"]), "View Channel and Send Messages");
    assert.equal(listOf(["A", "B", "C", "D"]), "A, B, C and D");
  });

  it("names the channel, the bot's role and what to allow", () => {
    assert.equal(
      channelFix("verify", "Agent Zero", ["View Channel", "Send Messages"]),
      'In Discord: right-click #verify, Edit Channel, Permissions, add the "Agent Zero" role ' +
        "and allow View Channel and Send Messages, then start the bot again.",
    );
  });
});
