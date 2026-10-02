import type { RankEntry } from "./website.ts";

/**
 * The rank roles, planned. Pure, so the tests run it exactly as the bot does; applying
 * the plan is rank-sync.ts.
 *
 * The website is the source of truth, and a rank role is never taken from a linked member
 * (the owner, 2026-09-29): every member the website lists gets the role for their rank and
 * keeps every rank role they already hold, even when listed without a rank. Only a member
 * missing from the list, which is what unlinking Discord on the website does, loses their
 * rank roles. A rank key the bot has no role for is reported, so the owner can add it.
 */

export type MemberRoles = { id: string; roleIds: ReadonlySet<string> };

export type RoleChange = { memberId: string; roleId: string; action: "add" | "remove" };

export type RankPlan = { changes: RoleChange[]; unknownRanks: string[] };

export function planRankRoles(
  entries: readonly RankEntry[],
  members: Iterable<MemberRoles>,
  rankRoles: ReadonlyMap<string, string>,
): RankPlan {
  const linked = new Set<string>();
  const wanted = new Map<string, string>();
  const unknownRanks = new Set<string>();

  for (const { discordId, rank } of entries) {
    linked.add(discordId);
    if (rank === null) continue;
    const roleId = rankRoles.get(rank);
    if (roleId) wanted.set(discordId, roleId);
    else unknownRanks.add(rank);
  }

  const changes: RoleChange[] = [];
  for (const member of members) {
    if (linked.has(member.id)) {
      const want = wanted.get(member.id);
      if (want && !member.roleIds.has(want)) changes.push({ memberId: member.id, roleId: want, action: "add" });
      continue;
    }
    for (const roleId of rankRoles.values()) {
      if (member.roleIds.has(roleId)) changes.push({ memberId: member.id, roleId, action: "remove" });
    }
  }
  return { changes, unknownRanks: [...unknownRanks] };
}
