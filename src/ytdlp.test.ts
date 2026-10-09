import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { explain, fetchArgs, lookupFor, onPath, parseResolved, toolVersions, type Runner } from "./ytdlp.ts";

const INFO = {
  title: "Rick Astley - Never Gonna Give You Up",
  duration: 213,
  ext: "webm",
  acodec: "opus",
  webpage_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
};
const LINE = JSON.stringify(INFO);

describe("the yt-dlp arguments", () => {
  it("ask for the description and then the audio in one run, and end the options before the target", () => {
    const search = fetchArgs({ kind: "search", query: "--version" });
    assert.deepEqual(search.slice(-2), ["--", "ytsearch1:--version"]);
    for (const flag of ["--no-playlist", "--no-cache-dir", "-j", "--no-simulate"]) assert.ok(search.includes(flag), flag);
    assert.deepEqual(search.slice(search.indexOf("-o"), search.indexOf("-o") + 2), ["-o", "-"]);
    assert.equal(search[search.indexOf("--playlist-items") + 1], "1", "a playlist link means its first song");
    assert.equal(search[search.indexOf("-f") + 1], "bestaudio[ext=webm][acodec=opus]/bestaudio/best");
    const link = fetchArgs({ kind: "url", url: "https://soundcloud.com/a/b" });
    assert.deepEqual(link.slice(-2), ["--", "https://soundcloud.com/a/b"]);
  });
});

describe("parseResolved", () => {
  it("reads yt-dlp's JSON into a track", () => {
    assert.deepEqual(parseResolved(LINE, "100000000000000001"), {
      track: {
        title: "Rick Astley - Never Gonna Give You Up",
        duration: 213,
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        format: "webm-opus",
        requestedBy: "100000000000000001",
      },
    });
    const live = parseResolved(JSON.stringify({ ...INFO, duration: null, ext: "mp4", acodec: "mp4a.40.2", title: "A\tlive\nstream" }), "1");
    assert.ok("track" in live);
    assert.equal(live.track.duration, 0);
    assert.equal(live.track.format, "other");
    assert.equal(live.track.title, "A live stream", "tabs and line breaks in a title are just spaces");
  });

  it("refuses what is not a track, and a link that led off the listed sites", () => {
    assert.deepEqual(parseResolved("", "1"), { problem: "could not fetch that one" });
    assert.deepEqual(parseResolved("not json", "1"), { problem: "could not fetch that one" });
    assert.deepEqual(parseResolved(JSON.stringify({ title: "x" }), "1"), { problem: "could not fetch that one" });
    assert.deepEqual(parseResolved(JSON.stringify({ ...INFO, webpage_url: "http://127.0.0.1:3000/x" }), "1"), {
      problem: "that link led somewhere I don't play from",
    });
  });
});

describe("explain", () => {
  it("turns yt-dlp's errors into a sentence for the person asking", () => {
    assert.match(explain("ERROR: [youtube] abc: Sign in to confirm you’re not a bot."), /sign-in/);
    assert.equal(explain("ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users."), "that one is private or age-restricted");
    assert.equal(explain("ERROR: [youtube:search] nothing: No video results"), "nothing found");
    assert.equal(explain("ERROR: Unsupported URL: https://x"), "that site is not supported");
    assert.equal(explain("ERROR: [youtube] x: Private video. Sign in if you've been granted access"), "that one is private or age-restricted");
    assert.equal(explain("something odd"), "could not fetch that one");
  });
});

describe("lookupFor", () => {
  it("passes links and searches through, and looks a Spotify link up by its title", async () => {
    assert.deepEqual(await lookupFor({ kind: "url", url: "https://youtu.be/x" }), { kind: "url", url: "https://youtu.be/x" });
    assert.deepEqual(await lookupFor({ kind: "search", query: "x" }), { kind: "search", query: "x" });
    const fetchImpl = (async (input: string | URL | Request) => {
      assert.match(String(input), /^https:\/\/open\.spotify\.com\/oembed\?url=https%3A%2F%2Fopen\.spotify\.com%2Ftrack%2Fabc$/);
      return new Response(JSON.stringify({ title: "Never Gonna Give You Up" }), { status: 200 });
    }) as typeof fetch;
    assert.deepEqual(await lookupFor({ kind: "spotify", url: "https://open.spotify.com/track/abc" }, fetchImpl), {
      kind: "search",
      query: "Never Gonna Give You Up",
    });
    const silent = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    await assert.rejects(lookupFor({ kind: "spotify", url: "https://open.spotify.com/track/abc" }, silent), /Spotify did not say/);
  });
});


describe("toolVersions", () => {
  const everywhere = () => true;

  it("reads the versions of the programs it finds on the PATH", async () => {
    const answers = [{ stdout: "2026.08.19\n" }, { stdout: "ffmpeg version N-126374-g089a48eb36-20260831 Copyright\nbuilt with gcc" }];
    const runner: Runner = async () => ({ stderr: "", code: 0, ...answers.shift() }) as never;
    assert.deepEqual(await toolVersions(runner, everywhere), { ytdlp: "2026.08.19", ffmpeg: "N-126374-g089a48eb36-20260831" });
  });

  it("tells a missing program from one that is slow to answer", async () => {
    const slow: Runner = async () => ({ stdout: "", stderr: "", code: null });
    assert.deepEqual(await toolVersions(slow, everywhere), { ytdlp: "(version unknown)", ffmpeg: "(version unknown)" });
    const odd: Runner = async () => ({ stdout: "x", stderr: "", code: 0 });
    assert.deepEqual(await toolVersions(odd, (command) => command === "ffmpeg"), { ytdlp: undefined, ffmpeg: "(version unknown)" });
  });

  it("looks for a program the way the system does", () => {
    const sep = process.platform === "win32" ? ";" : ":";
    const exe = process.platform === "win32" ? ".exe" : "";
    const env = { PATH: ["/tools", "/other"].join(sep) };
    const files = new Set([join("/other", `yt-dlp${exe}`)]);
    assert.equal(onPath("yt-dlp", env, (path) => files.has(path)), true);
    assert.equal(onPath("ffmpeg", env, (path) => files.has(path)), false);
    assert.equal(onPath("yt-dlp", {}, () => true), false, "no PATH, nothing found");
  });
});
