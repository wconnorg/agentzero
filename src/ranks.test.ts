import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planRankRoles, type MemberRoles } from "./ranks.ts";

const BRONZE = "900000000000000001";
const CADET = "900000000000000002";
const VERIFIED = "900000000000000009";
const bronzeOnly = new Map([["bronze", BRONZE]]);
const twoRanks = new Map([
  ["bronze", BRONZE],
  ["cadet", CADET],
]);

const ALICE = "100000000000000001";
const BOB = "100000000000000002";
const CAROL = "100000000000000003";

const member = (id: string, ...roleIds: string[]): MemberRoles => ({ id, roleIds: new Set(roleIds) });

describe("planRankRoles", () => {
  it("gives a listed member their rank's role", () => {
    const plan = planRankRoles([{ discordId: ALICE, rank: "bronze" }], [member(ALICE)], bronzeOnly);
    assert.deepEqual(plan.changes, [{ memberId: ALICE, roleId: BRONZE, action: "add" }]);
  });

  it("changes nothing for a member who already holds exactly their role", () => {
    const plan = planRankRoles([{ discordId: ALICE, rank: "bronze" }], [member(ALICE, BRONZE, VERIFIED)], bronzeOnly);
    assert.deepEqual(plan.changes, []);
  });

  it("takes the rank role from a member who is not listed (unlinked)", () => {
    const plan = planRankRoles([], [member(BOB, BRONZE, VERIFIED)], bronzeOnly);
    assert.deepEqual(plan.changes, [{ memberId: BOB, roleId: BRONZE, action: "remove" }]);
  });

  it("never takes a rank role from a linked member listed without a rank", () => {
    const plan = planRankRoles([{ discordId: BOB, rank: null }], [member(BOB, BRONZE)], bronzeOnly);
    assert.deepEqual(plan.changes, []);
  });

  it("gives nothing to a linked member without a rank", () => {
    const plan = planRankRoles([{ discordId: BOB, rank: null }], [member(BOB)], bronzeOnly);
    assert.deepEqual(plan.changes, []);
  });

  it("never touches a role that is not a rank role", () => {
    const plan = planRankRoles([], [member(CAROL, VERIFIED)], bronzeOnly);
    assert.deepEqual(plan.changes, []);
  });

  it("ignores listed members who are not in the server", () => {
    const plan = planRankRoles([{ discordId: CAROL, rank: "bronze" }], [member(ALICE)], bronzeOnly);
    assert.deepEqual(plan.changes, []);
  });

  it("adds a new rank's role and keeps the old one", () => {
    const plan = planRankRoles([{ discordId: ALICE, rank: "cadet" }], [member(ALICE, BRONZE)], twoRanks);
    assert.deepEqual(plan.changes, [{ memberId: ALICE, roleId: CADET, action: "add" }]);
  });

  it("takes every rank role from a member who unlinked", () => {
    const plan = planRankRoles([], [member(ALICE, BRONZE, CADET, VERIFIED)], twoRanks);
    assert.deepEqual(plan.changes, [
      { memberId: ALICE, roleId: BRONZE, action: "remove" },
      { memberId: ALICE, roleId: CADET, action: "remove" },
    ]);
  });

  it("leaves a member with a rank the bot has no role for alone, and reports the rank", () => {
    const plan = planRankRoles(
      [
        { discordId: ALICE, rank: "cadet" },
        { discordId: BOB, rank: "cadet" },
      ],
      [member(ALICE, BRONZE), member(BOB)],
      bronzeOnly,
    );
    assert.deepEqual(plan.changes, []);
    assert.deepEqual(plan.unknownRanks, ["cadet"]);
  });

  it("handles the whole server in one pass", () => {
    const plan = planRankRoles(
      [
        { discordId: ALICE, rank: "bronze" },
        { discordId: BOB, rank: null },
      ],
      [member(ALICE), member(BOB, BRONZE), member(CAROL, BRONZE), member("100000000000000004", BRONZE)],
      bronzeOnly,
    );
    assert.deepEqual(plan.changes, [
      { memberId: ALICE, roleId: BRONZE, action: "add" },
      { memberId: CAROL, roleId: BRONZE, action: "remove" },
      { memberId: "100000000000000004", roleId: BRONZE, action: "remove" },
    ]);
  });
});
