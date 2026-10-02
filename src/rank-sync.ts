import { RESTJSONErrorCodes, type Guild, type GuildMember } from "discord.js";
import { describeDiscordError, isDiscordCode, type MemberList } from "./discord.ts";
import { log } from "./log.ts";
import { planRankRoles, type MemberRoles, type RoleChange } from "./ranks.ts";
import type { RankEntry, Website } from "./website.ts";

/**
 * The rank roles, applied in the server: the whole server against the website's list
 * (on start and every few minutes), and one member when they join. The website is asked
 * first, so a failed answer never costs Discord a call and never changes a role. A linked
 * member never loses a rank role; see ranks.ts.
 */

const REASON = "ZeroCorps rank, from zerocorps.org";

export type RankSync = {
  /** Returns how many Discord accounts are linked on the website. */
  syncAll(): Promise<number>;
  restore(member: GuildMember): Promise<void>;
};

export function createRankSync(
  guild: Guild,
  members: MemberList,
  website: Website,
  rankRoles: ReadonlyMap<string, string>,
): RankSync {
  let firstSync = true;

  function warnUnknown(ranks: readonly string[]) {
    if (ranks.length === 0) return;
    log.warn(
      `the website has rank(s) the bot has no role for: ${ranks.join(", ")}. Add each to ` +
        "src/config.ts and its role id to .env; until then those members get no role for it.",
    );
  }

  /** Applies the changes in order; returns how many were made. */
  async function apply(changes: readonly RoleChange[]): Promise<number> {
    let made = 0;
    for (const { memberId, roleId, action } of changes) {
      const role = guild.roles.cache.get(roleId)?.name ?? roleId;
      try {
        if (action === "add") await guild.members.addRole({ user: memberId, role: roleId, reason: REASON });
        else await guild.members.removeRole({ user: memberId, role: roleId, reason: REASON });
        made++;
        log.info(action === "add" ? `gave ${role} to ${memberId}` : `took ${role} from ${memberId}`);
      } catch (error) {
        // Left the server since the list was read: nothing to do.
        if (isDiscordCode(error, RESTJSONErrorCodes.UnknownMember)) continue;
        log.error(`could not ${action} ${role} for ${memberId}: ${describeDiscordError(error)}`);
        // Every other change would fail the same way (the role sits too high, or was
        // deleted); one line per sync is enough, and the next sync tries again.
        if (
          isDiscordCode(error, RESTJSONErrorCodes.MissingPermissions) ||
          isDiscordCode(error, RESTJSONErrorCodes.UnknownRole)
        ) {
          break;
        }
      }
    }
    return made;
  }

  return {
    async syncAll() {
      const entries = await website.ranks();
      const humans = (await members()).filter((member) => !member.user.bot).map(memberRoles);
      const { changes, unknownRanks } = planRankRoles(entries, humans, rankRoles);
      warnUnknown(unknownRanks);
      const made = await apply(changes);
      if (firstSync || changes.length > 0) {
        log.info(`rank sync: ${entries.length} linked on the website, ${made} of ${changes.length} role changes made`);
      }
      firstSync = false;
      return entries.length;
    },

    async restore(member) {
      const profile = await website.profile(member.id);
      const entries: RankEntry[] = profile.linked ? [{ discordId: member.id, rank: profile.rank }] : [];
      const { changes, unknownRanks } = planRankRoles(entries, [memberRoles(member)], rankRoles);
      warnUnknown(unknownRanks);
      await apply(changes);
    },
  };
}

const memberRoles = (member: GuildMember): MemberRoles => ({
  id: member.id,
  roleIds: new Set(member.roles.cache.keys()),
});
