import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { log } from "./log.ts";
import { createReactionRole, pickMessage, type ReactionRoleSpec } from "./reaction-role.ts";

const BOT = "900000000000000000";
const OWNER = "100000000000000001";
const ALICE = "100000000000000002";
const BOB = "100000000000000003";
const ROLE = "300000000000000000";
const EMOJI = "🔔";

const spec: ReactionRoleSpec = {
  messageName: "alerts",
  roleName: "alerts",
  channelVariable: "ALERTS_CHANNEL_ID",
  channelId: "400000000000000000",
  emoji: EMOJI,
  text: "React!",
  roleId: ROLE,
  gave: (id) => `alerts on for ${id}`,
  took: (id) => `alerts off for ${id}`,
};

/** A message as far as picking looks at it: who wrote it, and whose reaction is on it. */
const candidate = (id: string, authorId: string, botReacted = false, othersReacted = false) => ({
  id,
  author: { id: authorId },
  reactions: { cache: new Map(botReacted || othersReacted ? [[EMOJI, { me: botReacted }]] : []) },
});

describe("pickMessage", () => {
  it("takes only the bot's message that carries the bot's own reaction", () => {
    const newestFirst = [
      candidate("stray-greeting", BOT),
      candidate("pin-notice", BOT),
      candidate("owner-chat", OWNER, false, true),
      candidate("alerts", BOT, true),
    ];
    assert.equal(pickMessage(newestFirst, BOT, EMOJI)?.id, "alerts");
  });

  it("does not take a bot message that only members reacted to", () => {
    assert.equal(pickMessage([candidate("stray-greeting", BOT, false, true)], BOT, EMOJI), undefined);
  });

  it("takes the newest if there are two, and nothing when there is none", () => {
    assert.equal(pickMessage([candidate("newer", BOT, true), candidate("older", BOT, true)], BOT, EMOJI)?.id, "newer");
    assert.equal(pickMessage([candidate("seeya", BOT), candidate("hi", OWNER)], BOT, EMOJI), undefined);
  });
});

/** A server with a few members and the bot's message; `slow` makes giving a role take a tick. */
function fakeServer(options: { reactedOnMessage?: string[]; holding?: string[]; slow?: boolean } = {}) {
  const roles = new Map<string, Set<string>>();
  for (const id of options.holding ?? []) roles.set(id, new Set([ROLE]));
  const changes: string[] = [];
  let reactsPutBack = 0;
  const guild = {
    members: {
      addRole: async ({ user, role }: { user: string; role: string }) => {
        if (options.slow) await new Promise((resolve) => setTimeout(resolve, 10));
        changes.push(`+${user}`);
        (roles.get(user) ?? roles.set(user, new Set()).get(user))?.add(role);
      },
      removeRole: async ({ user, role }: { user: string; role: string }) => {
        changes.push(`-${user}`);
        roles.get(user)?.delete(role);
      },
    },
  };
  const reactors = new Set(options.reactedOnMessage ?? []);
  const message = {
    id: "msg",
    react: async () => {
      reactsPutBack++;
    },
    reactions: {
      cache: {
        get: (emoji: string) =>
          emoji === EMOJI
            ? { users: { fetch: async () => ({ size: reactors.size, keys: () => reactors.values() }) } }
            : undefined,
      },
    },
  };
  const members = async () => ({
    get: (id: string) =>
      [OWNER, ALICE, BOB].includes(id)
        ? { user: { bot: false }, roles: { cache: { has: (roleId: string) => roles.get(id)?.has(roleId) ?? false } } }
        : undefined,
  });
  const has = (id: string) => roles.get(id)?.has(ROLE) ?? false;
  return { guild, message, members, changes, has, putBack: () => reactsPutBack, reactorsOnMessage: reactors };
}

const reaction = (messageId = "msg", emoji: string | null = EMOJI) => ({ message: { id: messageId }, emoji: { name: emoji } });

describe("a reaction role", () => {
  it("gives the role on a reaction and takes it on its removal; other messages, emojis and bots are ignored", async (t) => {
    t.mock.method(log, "info", () => {});
    const server = fakeServer();
    const role = createReactionRole(server.guild, server.members, BOT, server.message, spec);
    await role.reacted(reaction(), { id: ALICE }, true);
    assert.ok(server.has(ALICE));
    assert.equal(role.count, 1);
    await role.reacted(reaction(), { id: ALICE }, false);
    assert.ok(!server.has(ALICE));
    assert.equal(role.count, 0);

    await role.reacted(reaction("other"), { id: BOB }, true);
    await role.reacted(reaction("msg", "✅"), { id: BOB }, true);
    await role.reacted(reaction(), { id: BOT }, true);
    await role.reacted(reaction(), { id: "500000000000000000", bot: true }, true);
    assert.deepEqual(server.changes, [`+${ALICE}`, `-${ALICE}`]);
  });

  it("ends a quick reaction and un-reaction the right way round", async (t) => {
    t.mock.method(log, "info", () => {});
    const server = fakeServer({ slow: true });
    const role = createReactionRole(server.guild, server.members, BOT, server.message, spec);
    const on = role.reacted(reaction(), { id: ALICE }, true);
    const off = role.reacted(reaction(), { id: ALICE }, false);
    await Promise.all([on, off]);
    assert.deepEqual(server.changes, [`+${ALICE}`, `-${ALICE}`]);
    assert.ok(!server.has(ALICE));
  });

  it("puts its own reaction back when a moderator clears them, and takes the role from nobody", async () => {
    const server = fakeServer({ holding: [ALICE] });
    const role = createReactionRole(server.guild, server.members, BOT, server.message, spec);
    role.allCleared("other");
    assert.equal(server.putBack(), 0);
    role.allCleared("msg");
    role.emojiCleared(reaction());
    role.emojiCleared(reaction("msg", "✅"));
    assert.equal(server.putBack(), 2);
    assert.deepEqual(server.changes, []);
    assert.ok(server.has(ALICE));
    assert.equal(role.count, 0);
  });

  it("gives the role back to a member who returns with their reaction still there", async (t) => {
    t.mock.method(log, "info", () => {});
    const server = fakeServer();
    const role = createReactionRole(server.guild, server.members, BOT, server.message, spec);
    await role.reacted(reaction(), { id: ALICE }, true);
    server.changes.length = 0;
    await role.rejoined(ALICE);
    await role.rejoined(BOB);
    assert.deepEqual(server.changes, [`+${ALICE}`]);
  });

  it("catches up: gives the role to those who reacted while it was away, never takes it, skips itself", async (t) => {
    t.mock.method(log, "info", () => {});
    const server = fakeServer({ reactedOnMessage: [BOT, ALICE, BOB], holding: [BOB, OWNER] });
    const role = createReactionRole(server.guild, server.members, BOT, server.message, spec);
    await role.catchUp();
    assert.deepEqual(server.changes, [`+${ALICE}`]);
    assert.ok(server.has(OWNER), "a holder who never reacted keeps the role");
    assert.equal(role.count, 2);
  });

  it("applies a reaction removed during a catch-up on top of what it read", async (t) => {
    t.mock.method(log, "info", () => {});
    const server = fakeServer({ reactedOnMessage: [ALICE], holding: [ALICE] });
    const role = createReactionRole(server.guild, server.members, BOT, server.message, spec);
    const catchingUp = role.catchUp();
    await role.reacted(reaction(), { id: ALICE }, false);
    await catchingUp;
    assert.ok(!server.has(ALICE));
    assert.equal(role.count, 0, "the live removal wins over the list read during the catch-up");
    assert.deepEqual(server.changes, [`-${ALICE}`]);
  });
});
