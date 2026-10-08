import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chicago, cleanTitle, createCalendar, header, lines, parseFeed, post, type RecentMessage } from "./calendar.ts";
import { log } from "./log.ts";

const BOT = "100000000000000000";
/** Wednesday 7 October 2026, six in the morning in Chicago (daylight saving time). */
const SIX_AM = Date.parse("2026-10-07T06:00:00-05:00");

const FOMC = { title: "FOMC Meeting Minutes", country: "USD", date: "2026-10-07T14:00:00-04:00", impact: "High" };
const PMI = { title: "ISM Services PMI", country: "USD", date: "2026-10-07T10:00:00-04:00", impact: "Medium" };
const OIL = { title: "Crude Oil Inventories", country: "USD", date: "2026-10-07T10:30:00-04:00", impact: "Low" };
const GERMANY = { title: "German Factory Orders m/m", country: "EUR", date: "2026-10-07T02:00:00-04:00", impact: "Medium" };
const CLAIMS = { title: "Unemployment Claims", country: "USD", date: "2026-10-08T08:30:00-04:00", impact: "High" };
const FEED = [FOMC, PMI, OIL, GERMANY, CLAIMS];

const stamp = (date: string) => `<t:${Date.parse(date) / 1000}:t>`;

/** A message in the channel; ids count up with time, as Discord's do. */
const message = (id: number, createdTimestamp: number, authorId: string, content: string): RecentMessage => ({
  id: String(id),
  createdTimestamp,
  author: { id: authorId },
  content,
});

/** A channel holding `history`, newest first, read a page at a time like Discord's. */
function fakeChannel(history: RecentMessage[] = []) {
  const sent: string[] = [];
  const pages: number[] = [];
  const channel = {
    name: "index-analysis",
    messages: {
      fetch: async ({ limit, before }: { limit: number; before?: string }) => {
        const page = history.filter((entry) => before === undefined || BigInt(entry.id) < BigInt(before)).slice(0, limit);
        pages.push(page.length);
        return { values: () => page };
      },
    },
    send: async ({ content }: { content: string }) => {
      sent.push(content);
    },
  };
  return { channel, sent, pages };
}

/** A feed that answers each read with the next answer: a body (200), or a status code. */
function fakeFeed(...answers: (unknown[] | number)[]) {
  let reads = 0;
  const fetchImpl = (async () => {
    reads++;
    const answer = answers.shift();
    if (answer === undefined) throw new Error("no answer left");
    return typeof answer === "number"
      ? new Response("Too Many Requests", { status: answer })
      : new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, reads: () => reads };
}

describe("the Chicago clock", () => {
  it("reads the date, time and weekday in Chicago, in summer and winter time", () => {
    const summer = chicago(SIX_AM);
    assert.equal(summer.date, "2026-10-07");
    assert.equal(summer.minutes, 6 * 60);
    assert.equal(summer.weekday, 3);
    assert.match(summer.label, /^Wednesday,? 7 October 2026$/);
    const winter = chicago(Date.parse("2026-12-01T12:00:00Z"));
    assert.equal(winter.date, "2026-12-01");
    assert.equal(winter.minutes, 6 * 60);
    const evening = chicago(Date.parse("2026-10-07T23:30:00-05:00"));
    assert.equal(evening.date, "2026-10-07");
    assert.equal(evening.minutes, 23 * 60 + 30);
    assert.equal(chicago(Date.parse("2026-10-08T00:00:00-05:00")).minutes, 0);
  });
});

describe("the feed", () => {
  it("keeps the entries that make sense and counts the rest", () => {
    const { events, skipped } = parseFeed([
      FOMC,
      { title: "", country: "USD", date: FOMC.date, impact: "High" },
      { title: "Bank Holiday", country: "USD", date: "someday", impact: "Holiday" },
      42,
      { title: "OPEC-JMMC Meetings", country: "All", date: "2026-10-04T05:15:00-04:00", impact: "Medium" },
    ]);
    assert.equal(skipped, 3);
    assert.deepEqual(events, [
      { title: "FOMC Meeting Minutes", country: "USD", impact: "High", time: Date.parse(FOMC.date) },
      { title: "OPEC-JMMC Meetings", country: "ALL", impact: "Medium", time: Date.parse("2026-10-04T05:15:00-04:00") },
    ]);
  });

  it("refuses a feed that is not a list", () => {
    assert.throws(() => parseFeed({ events: [] }), /not a list/);
  });

  it("leaves real titles alone and strips anything that could format, link, mention or add a line", () => {
    for (const real of ["Core CPI m/m", "S&P/CS Composite-20 HPI y/y", "Prelim UoM Consumer Sentiment", "Fed's Beige Book"]) {
      assert.equal(cleanTitle(real), real);
    }
    assert.equal(cleanTitle("[FOMC Statement](https://evil.example)"), "FOMC Statement(https evil.example)");
    assert.equal(cleanTitle("Fed speaks\n# Buy now at https://evil.example"), "Fed speaks Buy now at https evil.example");
    assert.equal(cleanTitle("**Fed** _speaks_ @everyone <@123> <t:0:R> `x` ||y|| ~z~"), "Fed speaks everyone 123 t:0:R x y z");
    assert.equal(cleanTitle("a".repeat(100)).length, 80);
    assert.equal(cleanTitle(" \n\t "), "");
  });
});

describe("the day's lines", () => {
  const day = chicago(SIX_AM);
  const events = parseFeed(FEED).events;

  it("lists the day's red and orange folders in the chosen currencies, earliest first", () => {
    assert.deepEqual(lines(events, day, ["USD"]), [
      `🟠 ${stamp(PMI.date)} ISM Services PMI`,
      `🔴 ${stamp(FOMC.date)} FOMC Meeting Minutes`,
    ]);
    assert.equal(lines(events, day, ["USD", "EUR"])[0], `🟠 ${stamp(GERMANY.date)} German Factory Orders m/m`);
    assert.deepEqual(lines(events, chicago(Date.parse("2026-10-08T06:00:00-05:00")), ["USD"]), [
      `🔴 ${stamp(CLAIMS.date)} Unemployment Claims`,
    ]);
  });

  it("says so when there is nothing, and cuts a long day to Discord's length", () => {
    assert.equal(post(day, []), `${header(day)}\nNo red or orange folders today.`);
    const many = Array.from({ length: 80 }, (_, i) => `🔴 <t:1:t> ${"Event ".repeat(8)}${i}`);
    const text = post(day, many);
    assert.ok(text.length <= 2000, `${text.length} characters`);
    assert.match(text, /\n… and \d+ more$/);
    assert.ok(text.startsWith(`${header(day)}\n${many[0]}\n`));
  });
});

describe("the daily post", () => {
  it("waits for six o'clock, then posts once, and not again that day", async (t) => {
    t.mock.method(log, "info", () => {});
    let clock = SIX_AM - 60_000;
    const { channel, sent, pages } = fakeChannel();
    const feed = fakeFeed(FEED);
    const calendar = createCalendar(channel, BOT, ["USD"], { fetch: feed.fetchImpl, now: () => clock });
    await calendar.tick();
    assert.equal(sent.length, 0);
    assert.equal(pages.length, 0, "the channel is not read before the time");
    clock = SIX_AM;
    await calendar.tick();
    assert.deepEqual(sent, [`${header(chicago(SIX_AM))}\n🟠 ${stamp(PMI.date)} ISM Services PMI\n🔴 ${stamp(FOMC.date)} FOMC Meeting Minutes`]);
    clock += 60_000;
    await calendar.tick();
    assert.equal(sent.length, 1);
    assert.equal(feed.reads(), 1, "the feed is read once a day");
    assert.equal(pages.length, 1, "the channel is read once a day");
  });

  it("finds the post it already made today, after a restart, and posts again the next day", async (t) => {
    t.mock.method(log, "info", () => {});
    let clock = SIX_AM + 3 * 3_600_000;
    const { channel, sent } = fakeChannel([message(2, SIX_AM + 1000, BOT, `${header(chicago(SIX_AM))}\n🔴 earlier today`)]);
    const feed = fakeFeed(FEED);
    const calendar = createCalendar(channel, BOT, ["USD"], { fetch: feed.fetchImpl, now: () => clock });
    await calendar.tick();
    assert.equal(sent.length, 0);
    assert.equal(feed.reads(), 0);
    clock += 24 * 3_600_000;
    await calendar.tick();
    assert.deepEqual(sent, [`${header(chicago(clock))}\n🔴 ${stamp(CLAIMS.date)} Unemployment Claims`]);
  });

  it("looks behind a busy day's chatter for its post, but no further back than the posting time", async (t) => {
    t.mock.method(log, "info", () => {});
    const noon = SIX_AM + 6 * 3_600_000;
    const chatter = Array.from({ length: 250 }, (_, i) => message(1000 - i, noon - i * 60_000, "200000000000000000", `chat ${i}`));
    const ownPost = message(700, SIX_AM + 1000, BOT, `${header(chicago(SIX_AM))}\n🔴 earlier today`);
    const yesterday = message(600, SIX_AM - 20 * 3_600_000, BOT, `${header(chicago(SIX_AM - 24 * 3_600_000))}\n🔴 old`);
    const busy = fakeChannel([...chatter, ownPost, yesterday]);
    const calendar = createCalendar(busy.channel, BOT, ["USD"], { fetch: fakeFeed(FEED).fetchImpl, now: () => noon });
    await calendar.tick();
    assert.equal(busy.sent.length, 0, "the post was found behind 250 newer messages");
    assert.deepEqual(busy.pages, [100, 100, 52], "found on the third page, which also holds the older messages");

    const old = Array.from({ length: 100 }, (_, i) => message(500 - i, SIX_AM - 3_600_000 - i * 60_000, "200000000000000000", `old ${i}`));
    const quiet = fakeChannel([yesterday, ...old]);
    const again = createCalendar(quiet.channel, BOT, ["USD"], { fetch: fakeFeed(FEED).fetchImpl, now: () => noon });
    await again.tick();
    assert.equal(quiet.sent.length, 1, "nothing since six o'clock, so it posts");
    assert.deepEqual(quiet.pages, [100], "a page older than the posting time ends the search");
  });

  it("does not take someone else's message for its own post", async (t) => {
    t.mock.method(log, "info", () => {});
    const { channel, sent } = fakeChannel([message(2, SIX_AM + 1000, "200000000000000000", header(chicago(SIX_AM)))]);
    const calendar = createCalendar(channel, BOT, ["USD"], { fetch: fakeFeed(FEED).fetchImpl, now: () => SIX_AM });
    await calendar.tick();
    assert.equal(sent.length, 1);
  });

  it("posts a quiet weekday, but not a quiet weekend", async (t) => {
    t.mock.method(log, "info", () => {});
    const friday = Date.parse("2026-10-09T06:00:00-05:00");
    const { channel, sent } = fakeChannel();
    const calendar = createCalendar(channel, BOT, ["USD"], { fetch: fakeFeed(FEED).fetchImpl, now: () => friday });
    await calendar.tick();
    assert.deepEqual(sent, [`${header(chicago(friday))}\nNo red or orange folders today.`]);

    const saturday = Date.parse("2026-10-10T06:00:00-05:00");
    const quiet = fakeChannel();
    const weekend = createCalendar(quiet.channel, BOT, ["USD"], { fetch: fakeFeed(FEED).fetchImpl, now: () => saturday });
    await weekend.tick();
    assert.equal(quiet.sent.length, 0);
  });

  it("posts nothing when the feed fails, is empty or unreadable, and tries again", async (t) => {
    t.mock.method(log, "info", () => {});
    t.mock.method(log, "warn", () => {});
    const { channel, sent } = fakeChannel();
    const feed = fakeFeed(429, [], [{ currency: "USD" }], FEED);
    const calendar = createCalendar(channel, BOT, ["USD"], { fetch: feed.fetchImpl, now: () => SIX_AM });
    await assert.rejects(calendar.tick(), /HTTP 429/);
    await assert.rejects(calendar.tick(), /no events the bot could read/);
    await assert.rejects(calendar.tick(), /no events the bot could read/);
    assert.equal(sent.length, 0);
    await calendar.tick();
    assert.equal(sent.length, 1);
    assert.equal(feed.reads(), 4);
  });

  it("names the permissions when Discord shuts it out of the channel", async () => {
    const { channel } = fakeChannel();
    const { DiscordAPIError, RESTJSONErrorCodes } = await import("discord.js");
    channel.messages.fetch = async () => {
      throw new DiscordAPIError({ code: RESTJSONErrorCodes.MissingAccess, message: "Missing Access" }, 50001, 403, "GET", "", {});
    };
    const calendar = createCalendar(channel, BOT, ["USD"], { fetch: fakeFeed(FEED).fetchImpl, now: () => SIX_AM });
    await assert.rejects(calendar.tick(), /View Channel, Send Messages and Read Message History in #index-analysis/);
  });
});
