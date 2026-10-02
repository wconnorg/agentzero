import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { farewell, greeting } from "./greetings.ts";

const MEMBER = "100000000000000001";

describe("the greetings", () => {
  it("welcome and see off a member by mention", () => {
    assert.equal(greeting(MEMBER), `Welcome <@${MEMBER}>!`);
    assert.equal(farewell(MEMBER), `Seeya <@${MEMBER}>!`);
  });
});
