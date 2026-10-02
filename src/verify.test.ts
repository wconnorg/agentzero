import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VERIFY_EMOJI, VERIFY_TEXT, pickVerifyMessage } from "./verify.ts";

const BOT = "900000000000000000";
const OWNER = "100000000000000001";

/** A message as far as picking looks at it: who wrote it, and whose ✅ is on it. */
const message = (id: string, authorId: string, botChecked = false, othersChecked = false) => ({
  id,
  author: { id: authorId },
  reactions: {
    cache: new Map(botChecked || othersChecked ? [[VERIFY_EMOJI, { me: botChecked }]] : []),
  },
});

describe("pickVerifyMessage", () => {
  it("takes only the bot's message that carries the bot's own ✅", () => {
    const newestFirst = [
      message("stray-greeting", BOT),
      message("pin-notice", BOT),
      message("owner-chat", OWNER, false, true),
      message("verify", BOT, true),
    ];
    assert.equal(pickVerifyMessage(newestFirst, BOT)?.id, "verify");
  });

  it("does not take a bot message that only members put a ✅ on", () => {
    assert.equal(pickVerifyMessage([message("stray-greeting", BOT, false, true)], BOT), undefined);
  });

  it("takes the newest verify message if there are two", () => {
    const newestFirst = [message("newer", BOT, true), message("older", BOT, true)];
    assert.equal(pickVerifyMessage(newestFirst, BOT)?.id, "newer");
  });

  it("finds nothing when the bot has no verify message yet", () => {
    assert.equal(pickVerifyMessage([message("seeya", BOT), message("hi", OWNER)], BOT), undefined);
  });
});

describe("the verify text", () => {
  it("is what the owner approved", () => {
    assert.ok(VERIFY_TEXT.includes(`React with ${VERIFY_EMOJI} below to verify`));
    assert.ok(VERIFY_TEXT.endsWith("Link your Discord in the Academy's settings."));
    assert.ok(!/rank|pin/i.test(VERIFY_TEXT));
  });
});
