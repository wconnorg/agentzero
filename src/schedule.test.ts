import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextDelayMs } from "./schedule.ts";

const FIVE_MINUTES = 5 * 60_000;

describe("nextDelayMs", () => {
  it("waits the interval after a success or a first failure", () => {
    assert.equal(nextDelayMs(FIVE_MINUTES, 0), FIVE_MINUTES);
    assert.equal(nextDelayMs(FIVE_MINUTES, 1), FIVE_MINUTES);
  });

  it("doubles the wait for each failure in a row, up to 30 minutes", () => {
    assert.equal(nextDelayMs(FIVE_MINUTES, 2), 10 * 60_000);
    assert.equal(nextDelayMs(FIVE_MINUTES, 3), 20 * 60_000);
    assert.equal(nextDelayMs(FIVE_MINUTES, 4), 30 * 60_000);
    assert.equal(nextDelayMs(FIVE_MINUTES, 50), 30 * 60_000);
  });

  it("never comes back sooner than the website asked", () => {
    assert.equal(nextDelayMs(FIVE_MINUTES, 1, 40 * 60_000), 40 * 60_000);
    assert.equal(nextDelayMs(FIVE_MINUTES, 1, 1_000), FIVE_MINUTES);
  });
});
