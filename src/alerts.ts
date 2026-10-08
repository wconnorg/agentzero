/**
 * The alerts message and the alerts role (the owner, 2026-10-08): a member who reacts with
 * 🔔 gets the role, for the owner to @mention when new analysis is posted, and removing the
 * 🔔 takes it away. The mechanics are reaction-role.ts, shared with the verify message.
 */

export const ALERTS_EMOJI = "🔔";

/**
 * The alerts message. Edit it here: on its next start the bot edits the posted message to
 * match, and the reactions stay.
 */
export const ALERTS_TEXT = [
  "**Analysis notifications**",
  "",
  `React with ${ALERTS_EMOJI} below to receive analysis notifications.`,
  `Remove your ${ALERTS_EMOJI} to stop them.`,
].join("\n");
