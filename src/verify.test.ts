import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VERIFY_EMOJI, VERIFY_TEXT } from "./verify.ts";

describe("the verify text", () => {
  it("is what the owner approved", () => {
    assert.ok(VERIFY_TEXT.includes(`React with ${VERIFY_EMOJI} below to verify`));
    assert.ok(VERIFY_TEXT.endsWith("Link your Discord in the Academy's settings."));
    assert.ok(!/rank|pin/i.test(VERIFY_TEXT));
  });
});
