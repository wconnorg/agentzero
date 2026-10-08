/**
 * The verify message and the verified role: entirely the bot's own, never the website's.
 * The verify channel holds this one message; join and leave greetings have their own
 * channels (greetings.ts). Reacting with ✅ gives the role, removing the ✅ takes it away,
 * which hides the verified-only channels again (the owner, 2026-09-29); the mechanics are
 * reaction-role.ts, shared with the alerts message (alerts.ts).
 */

export const VERIFY_EMOJI = "✅";

/**
 * The verify message. Edit it here: on its next start the bot edits the posted message to
 * match, and the reactions stay. The angle brackets stop Discord previewing the link.
 */
export const VERIFY_TEXT = [
  "**Welcome to ZeroCorps.**",
  "",
  `React with ${VERIFY_EMOJI} below to verify and open the rest of the server.`,
  "",
  "Learn to trade with ZeroCorps Academy: <https://zerocorps.org/academy>",
  "Link your Discord in the Academy's settings.",
].join("\n");
