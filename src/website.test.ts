import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWebsite, WebsiteError, type WebsiteErrorKind } from "./website.ts";

const ORIGIN = "https://zerocorps.example";
const SECRET = "test-secret-that-is-at-least-32-characters-long";
const ID = "123456789012345678";

type Call = { url: string; init: RequestInit | undefined };

/** A website that answers every call with the next response in `answers`. */
function fakeWebsite(...answers: (Response | Error)[]) {
  const calls: Call[] = [];
  let clock = 1_000_000;
  const website = createWebsite({
    origin: ORIGIN,
    secret: SECRET,
    now: () => clock,
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      const answer = answers.shift();
      if (!answer) throw new Error("no answer left");
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  return { website, calls, advance: (ms: number) => (clock += ms) };
}

const json = (status: number, body: unknown, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

async function rejectsWith(promise: Promise<unknown>, kind: WebsiteErrorKind): Promise<WebsiteError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof WebsiteError, `expected a WebsiteError, got ${String(error)}`);
    assert.equal(error.kind, kind);
    assert.ok(!error.message.includes(SECRET), "the secret must never appear in an error");
    return error;
  }
  assert.fail(`expected a "${kind}" error`);
}

describe("the website client", () => {
  it("sends the secret, and never follows a redirect with it", async () => {
    const { website, calls } = fakeWebsite(json(200, { members: [] }));
    await website.ranks();
    assert.equal(calls[0]?.url, `${ORIGIN}/api/internal/discord/ranks`);
    const headers = new Headers(calls[0]?.init?.headers);
    assert.equal(headers.get("x-internal-secret"), SECRET);
    assert.equal(calls[0]?.init?.redirect, "error");
  });

  it("reads the ranks list", async () => {
    const { website } = fakeWebsite(
      json(200, {
        members: [
          { discordId: ID, rank: "bronze" },
          { discordId: "223456789012345678", rank: null },
        ],
      }),
    );
    assert.deepEqual(await website.ranks(), [
      { discordId: ID, rank: "bronze" },
      { discordId: "223456789012345678", rank: null },
    ]);
  });

  it("rejects the whole ranks list when one entry is malformed", async () => {
    const { website } = fakeWebsite(
      json(200, {
        members: [
          { discordId: ID, rank: "bronze" },
          { discordId: "not-an-id", rank: null },
        ],
      }),
    );
    await rejectsWith(website.ranks(), "unexpected");
  });

  it("rejects a ranks answer without a members list", async () => {
    const { website } = fakeWebsite(json(200, { error: "oops" }));
    await rejectsWith(website.ranks(), "unexpected");
  });

  it("reads a linked profile, keeping only the rank", async () => {
    const { website, calls } = fakeWebsite(json(200, { linked: true, username: "trader_99", rank: "bronze" }));
    assert.deepEqual(await website.profile(ID), { linked: true, rank: "bronze" });
    assert.equal(calls[0]?.url, `${ORIGIN}/api/internal/discord/${ID}/profile`);
  });

  it("reads an unlinked profile from the JSON 404", async () => {
    const { website } = fakeWebsite(json(404, { linked: false }));
    assert.deepEqual(await website.profile(ID), { linked: false });
  });

  it("does not take an HTML 404 for 'not linked'", async () => {
    const { website } = fakeWebsite(new Response("<html>Not found</html>", { status: 404 }));
    await rejectsWith(website.profile(ID), "unexpected");
  });

  it("never calls the website with something that is not a Discord id", async () => {
    const { website, calls } = fakeWebsite();
    await rejectsWith(website.profile("../stats"), "bad_request");
    assert.equal(calls.length, 0);
  });

  it("reads the accounts count", async () => {
    const { website, calls } = fakeWebsite(json(200, { academyMembers: 42 }));
    assert.deepEqual(await website.stats(), { academyMembers: 42 });
    assert.equal(calls[0]?.url, `${ORIGIN}/api/internal/stats`);
  });

  it("rejects a count that is not a whole, non-negative number", async () => {
    const bad = [{}, { academyMembers: "42" }, { academyMembers: -1 }, { academyMembers: 1.5 }, { academyMembers: null }];
    for (const body of bad) {
      const { website } = fakeWebsite(json(200, body));
      await rejectsWith(website.stats(), "unexpected");
    }
  });

  it("explains a wrong secret (401)", async () => {
    const { website } = fakeWebsite(json(401, { error: "unauthorized" }));
    const error = await rejectsWith(website.ranks(), "unauthorized");
    assert.match(error.message, /INTERNAL_API_SECRET/);
  });

  it("explains the API being off (503)", async () => {
    const { website } = fakeWebsite(json(503, { error: "disabled" }));
    await rejectsWith(website.ranks(), "disabled");
  });

  it("reports any other 503 as unexpected", async () => {
    const { website } = fakeWebsite(new Response("upstream down", { status: 503 }));
    await rejectsWith(website.ranks(), "unexpected");
  });

  it("pauses every call after a 429, for as long as the website asks", async () => {
    const { website, calls, advance } = fakeWebsite(
      json(429, { error: "too_many_requests", retryAfterSeconds: 30 }),
      json(200, { members: [] }),
    );
    const error = await rejectsWith(website.ranks(), "rate_limited");
    assert.equal(error.retryAfterMs, 30_000);

    advance(29_000);
    const paused = await rejectsWith(website.profile(ID), "paused");
    assert.equal(paused.retryAfterMs, 1_000);
    assert.equal(calls.length, 1, "no call reaches the website while paused");

    advance(1_000);
    assert.deepEqual(await website.ranks(), []);
    assert.equal(calls.length, 2);
  });

  it("recognises Vercel's Security Checkpoint and backs off for ten minutes", async () => {
    const { website, calls, advance } = fakeWebsite(
      new Response("<html><title>Vercel Security Checkpoint</title></html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      }),
      json(200, { members: [] }),
    );
    const error = await rejectsWith(website.ranks(), "firewall");
    assert.match(error.message, /Security Checkpoint/);
    assert.match(error.message, /Firewall/);

    advance(9 * 60_000);
    await rejectsWith(website.ranks(), "paused");
    assert.equal(calls.length, 1);

    advance(60_000);
    assert.deepEqual(await website.ranks(), []);
  });

  it("keeps the secret out of an error that quotes the header back", async () => {
    const { website } = fakeWebsite(new TypeError(`Headers.append: "${SECRET}" is an invalid header value.`));
    const error = await rejectsWith(website.ranks(), "network");
    assert.match(error.message, /invalid header value/);
  });

  it("reports a network failure without the secret", async () => {
    const { website } = fakeWebsite(new TypeError("fetch failed", { cause: new Error("unexpected redirect") }));
    const error = await rejectsWith(website.ranks(), "network");
    assert.match(error.message, /unexpected redirect/);
  });
});
