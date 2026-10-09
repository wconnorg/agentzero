import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createQueue, describe as describeTrack, formatDuration, isAllowedLink, parseRequest, type Track } from "./tracks.ts";

describe("parseRequest", () => {
  it("tells links, Spotify links and searches apart", () => {
    assert.deepEqual(parseRequest("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), {
      kind: "url",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    assert.deepEqual(parseRequest("https://youtu.be/dQw4w9WgXcQ"), { kind: "url", url: "https://youtu.be/dQw4w9WgXcQ" });
    assert.deepEqual(parseRequest("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc"), {
      kind: "spotify",
      url: "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc",
    });
    assert.deepEqual(parseRequest("  never gonna   give you up "), { kind: "search", query: "never gonna give you up" });
    assert.deepEqual(parseRequest("soundcloud.com/some/track"), { kind: "search", query: "soundcloud.com/some/track" });
  });

  it("takes links to the listed sites only, and says so for the rest", () => {
    assert.equal(parseRequest("https://m.soundcloud.com/a/b")?.kind, "url");
    assert.equal(parseRequest("https://someband.bandcamp.com/track/x")?.kind, "url");
    assert.deepEqual(parseRequest("https://example.com/song.mp3"), { kind: "other-link", host: "example.com" });
    for (const sneaky of [
      "http://127.0.0.1.nip.io:3000/",
      "http://localtest.me/",
      "http://localhost:3000/x",
      "https://127.0.0.1/x",
      "http://192.168.1.10/x",
      "http://[::1]/x",
      "http://router/x",
      "https://notyoutube.com/watch?v=1",
      "https://youtube.com.evil.example/watch?v=1",
    ]) {
      assert.equal(parseRequest(sneaky)?.kind, "other-link", sneaky);
    }
    assert.equal(parseRequest("https://user:pass@www.youtube.com/watch?v=1")?.kind, "other-link", "no logins in links");
    assert.equal(isAllowedLink("ftp://youtube.com/x"), false);
    assert.equal(isAllowedLink("not a url"), false);
  });

  it("refuses nothing, and cleans control characters", () => {
    assert.equal(parseRequest("   "), undefined);
    assert.deepEqual(parseRequest("a\u0000b​c"), { kind: "search", query: "a b c" });
    assert.equal((parseRequest("x".repeat(400)) as { query: string }).query.length, 300);
  });
});

describe("formatDuration", () => {
  it("shows minutes, hours when needed, and live for the unknown", () => {
    assert.equal(formatDuration(187), "3:07");
    assert.equal(formatDuration(3765), "1:02:45");
    assert.equal(formatDuration(0), "live");
    assert.equal(formatDuration(Number.NaN), "live");
  });

  it("names a track without letting its title format the reply", () => {
    const track: Track = { title: "Song **loud** `x`", duration: 59.6, url: "https://x.example", format: "other", requestedBy: "1" };
    assert.equal(describeTrack(track), "**Song \\*\\*loud\\*\\* \\`x\\`** (1:00)");
  });
});

describe("the queue", () => {
  it("plays in order, says how many are ahead, and goes back", () => {
    const queue = createQueue<string>();
    assert.equal(queue.current(), undefined);
    assert.equal(queue.hasPrevious(), false);
    assert.equal(queue.add("a"), 0);
    assert.equal(queue.current(), "a");
    assert.equal(queue.add("b"), 1);
    assert.equal(queue.add("c"), 2);
    assert.deepEqual(queue.upcoming(), ["b", "c"]);
    assert.equal(queue.next(), "b");
    assert.equal(queue.hasPrevious(), true);
    assert.equal(queue.previous(), "a");
    assert.equal(queue.previous(), "a", "before the first, the first again");
    assert.equal(queue.next(), "b");
    assert.equal(queue.next(), "c");
    assert.deepEqual(queue.upcoming(), []);
  });

  it("knows when everything has played, and takes a new song from there", () => {
    const queue = createQueue<string>();
    queue.add("a");
    assert.equal(queue.next(), undefined);
    assert.equal(queue.current(), undefined, "nothing is current once everything has played");
    assert.equal(queue.hasPrevious(), true);
    assert.equal(queue.previous(), "a", "previous replays the last one");
    assert.equal(queue.next(), undefined);
    assert.equal(queue.add("b"), 0, "a new song after the end plays now");
    assert.equal(queue.current(), "b");
    queue.clear();
    assert.equal(queue.current(), undefined);
    assert.equal(queue.hasPrevious(), false);
    assert.deepEqual(queue.upcoming(), []);
    assert.equal(queue.add("c"), 0);
  });

  it("keeps only the last fifty played", () => {
    const queue = createQueue<number>();
    for (let i = 0; i < 80; i++) queue.add(i);
    for (let i = 0; i < 70; i++) queue.next();
    assert.equal(queue.current(), 70);
    queue.add(80);
    assert.equal(queue.current(), 70);
    assert.deepEqual(queue.upcoming().at(-1), 80);
    let back = 0;
    while (queue.previous() !== 20) back++;
    assert.equal(back, 49, "forty-nine steps back from the current one reach the oldest kept");
    assert.equal(queue.previous(), 20, "nothing older is kept");
  });
});
