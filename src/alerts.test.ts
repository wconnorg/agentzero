import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALERTS_EMOJI, ALERTS_TEXT } from "./alerts.ts";
import { VERIFY_EMOJI } from "./verify.ts";

describe("the alerts text", () => {
  it("says what to react with, and uses an emoji of its own", () => {
    assert.ok(ALERTS_TEXT.includes(`React with ${ALERTS_EMOJI} below to receive analysis notifications`));
    assert.notEqual(ALERTS_EMOJI, VERIFY_EMOJI, "the bot tells its messages apart by their emoji");
    assert.ok(!/pin/i.test(ALERTS_TEXT));
  });
});
