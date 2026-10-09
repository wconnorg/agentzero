import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Readable } from "node:stream";
import { StreamType } from "@discordjs/voice";
import { errorMessage, log } from "./log.ts";
import { isAllowedLink, type Request, type Track } from "./tracks.ts";

/**
 * Fetching music (the owner, 2026-10-08): yt-dlp finds a track, on YouTube, SoundCloud and
 * the other sites tracks.ts lists, and streams its audio, in one run: the audio comes on
 * its standard output, and a line of JSON saying what it found on its error stream (that
 * is where yt-dlp puts its words when the output carries the audio). One run per song,
 * because yt-dlp as installed unpacks itself at every start, which takes a while on a slow
 * computer. When the audio is Opus in WebM, as YouTube's is, it goes to Discord untouched;
 * otherwise FFmpeg converts it to Opus on the way. Both are programs on the PATH (the
 * README says how to install them), run with arguments and never through a shell, and
 * nothing is written to disk. A Spotify link is looked up by its title on Spotify's public
 * oEmbed endpoint and then searched for on YouTube, since Spotify streams to no one.
 */

export const YTDLP = "yt-dlp";
export const FFMPEG = "ffmpeg";
const WEBM_OPUS = "bestaudio[ext=webm][acodec=opus]";
/**
 * Every run: one track (a playlist link means its first song), nothing cached on disk,
 * Node as the JavaScript runtime YouTube's player needs (Deno, if present, is preferred).
 */
const COMMON = [
  "--no-playlist", "--playlist-items", "1",
  "--no-cache-dir", "--no-warnings", "--quiet",
  "--js-runtimes", "node",
  "--socket-timeout", "15",
];
/** yt-dlp as installed unpacks itself at every start, which takes a while on a slow computer. */
const INFO_TIMEOUT_MS = 90_000;
const VERSION_TIMEOUT_MS = 60_000;
const OEMBED_TIMEOUT_MS = 10_000;

export type Lookup = { kind: "url"; url: string } | { kind: "search"; query: string };

/** The arguments that make yt-dlp describe the track in one line of JSON and stream its audio. */
export function fetchArgs(lookup: Lookup): string[] {
  const target = lookup.kind === "url" ? lookup.url : `ytsearch1:${lookup.query}`;
  return [...COMMON, "-f", `${WEBM_OPUS}/bestaudio/best`, "-j", "--no-simulate", "-o", "-", "--", target];
}

/** FFmpeg: whatever comes in, Opus in Ogg out, as Discord plays it. */
export const FFMPEG_ARGS = [
  "-hide_banner", "-loglevel", "error",
  "-i", "pipe:0", "-vn",
  "-c:a", "libopus", "-b:a", "128k", "-ar", "48000", "-ac", "2",
  "-f", "ogg", "pipe:1",
];

export type Resolved = { track: Track } | { problem: string };

/** The track yt-dlp's JSON describes, or what is wrong with it. */
export function parseResolved(json: string, requestedBy: string): Resolved {
  let info: unknown;
  try {
    info = JSON.parse(json);
  } catch {
    return { problem: "could not fetch that one" };
  }
  if (typeof info !== "object" || info === null) return { problem: "could not fetch that one" };
  const { title, duration, ext, acodec, webpage_url: url } = info as Record<string, unknown>;
  if (typeof title !== "string" || !title.trim() || typeof url !== "string") return { problem: "could not fetch that one" };
  // yt-dlp followed the link somewhere else: the audio would come from there, so the same list applies.
  if (!isAllowedLink(url)) return { problem: "that link led somewhere I don't play from" };
  const seconds = typeof duration === "number" ? duration : Number(duration);
  return {
    track: {
      title: title.replace(/\s+/g, " ").trim().slice(0, 200),
      duration: Number.isFinite(seconds) && seconds > 0 ? seconds : 0,
      url,
      format: ext === "webm" && acodec === "opus" ? "webm-opus" : "other",
      requestedBy,
    },
  };
}

/** What a yt-dlp failure means for the person who asked. */
export function explain(stderr: string): string {
  if (/private video|members-only|age.restricted|confirm your age/i.test(stderr)) return "that one is private or age-restricted";
  if (/sign in to confirm/i.test(stderr)) {
    return "YouTube is asking for a sign-in before serving that one, as it does to bots now and then; try again in a while, or another link";
  }
  if (/no video results|did not return any data|no such video|video unavailable|not available/i.test(stderr)) return "nothing found";
  if (/unsupported url/i.test(stderr)) return "that site is not supported";
  if (/is not a valid url/i.test(stderr)) return "that is not a link";
  return "could not fetch that one";
}

/** A failure the person who asked can be told about, in their own terms. */
export class FetchError extends Error {
  override name = "FetchError";
}

const isMissingTool = (error: unknown) => error instanceof Error && (error as { code?: string }).code === "ENOENT";
const firstErrorLine = (text: string) =>
  text.split(/\r?\n/).find((line) => /error/i.test(line))?.trim() ?? text.trim().split(/\r?\n/)[0] ?? "";

/** The song a Spotify link is, by its title, from Spotify's public oEmbed endpoint. */
export async function spotifyTitle(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS),
  }).catch(() => undefined);
  const body: unknown = response?.ok ? await response.json().catch(() => undefined) : undefined;
  const title =
    typeof body === "object" && body !== null && typeof (body as { title?: unknown }).title === "string"
      ? (body as { title: string }).title.trim()
      : "";
  if (!title) throw new FetchError("Spotify did not say what that link is; try the song's name instead");
  return title;
}

/** What to ask yt-dlp for: the request itself, or a Spotify link's title as a search. */
export async function lookupFor(request: Exclude<Request, { kind: "other-link" }>, fetchImpl: typeof fetch = fetch): Promise<Lookup> {
  return request.kind === "spotify" ? { kind: "search", query: await spotifyTitle(request.url, fetchImpl) } : request;
}

/**
 * Ends a program and everything it started: yt-dlp as installed is a launcher around the
 * real program, and FFmpeg may run under it for a live stream, so on Windows the whole tree
 * goes, through taskkill; elsewhere the process does.
 */
export function endProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
  } else {
    child.kill();
  }
}

/** A track being fetched: what it is, once yt-dlp says, and its audio as it comes. */
export type Fetching = { info: Promise<Track>; audio: Readable; close(): void };

/**
 * One yt-dlp run for a track: its description, then its audio, which waits until it is
 * read. The description, and anything yt-dlp has to complain about, come line by line on
 * the error stream; the first line that is JSON is the description.
 */
export function startFetch(lookup: Lookup, requestedBy: string): Fetching {
  const child = spawn(YTDLP, fetchArgs(lookup), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    endProcess(child);
    child.stdout.destroy();
  };
  const info = new Promise<Track>((resolve, reject) => {
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
    };
    const fail = (reason: string) => settle(() => reject(new FetchError(reason)));
    timer = setTimeout(() => {
      fail("yt-dlp took too long; try again");
      close();
    }, INFO_TIMEOUT_MS);
    let pending = "";
    let complaints = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      pending += chunk;
      for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (!line) continue;
        if (!settled && line.startsWith("{")) {
          const resolved = parseResolved(line, requestedBy);
          if ("problem" in resolved) {
            log.warn(`music: yt-dlp's answer for a ${lookup.kind} was not usable: ${resolved.problem}`);
            fail(resolved.problem);
            close();
          } else {
            settle(() => resolve(resolved.track));
          }
        } else if (complaints.length < 10_000) {
          complaints += `${line}\n`;
        }
      }
    });
    child.on("error", (error) => fail(isMissingTool(error) ? "yt-dlp is not installed on the bot's computer" : errorMessage(error)));
    child.on("close", (code) => {
      if (!settled) {
        log.warn(`music: yt-dlp ended with code ${code} on a ${lookup.kind}: ${firstErrorLine(complaints)}`);
        fail(explain(complaints));
      } else if (code !== 0 && !closed && complaints.trim()) {
        log.warn(`music: yt-dlp: ${firstErrorLine(complaints)}`);
      }
    });
  });
  // Nobody may be waiting any more; a failure then only matters to whoever reads the audio.
  info.catch(() => {});
  return { info, audio: child.stdout, close };
}

export type Playback = { stream: Readable; type: StreamType; close(): void };

/** The fetched audio as Discord plays it: WebM/Opus as is, or FFmpeg's Ogg/Opus from anything else. */
export function toPlayback(fetching: Fetching, format: Track["format"]): Playback {
  if (format === "webm-opus") return { stream: fetching.audio, type: StreamType.WebmOpus, close: fetching.close };
  const converter = spawn(FFMPEG, FFMPEG_ARGS, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  fetching.audio.pipe(converter.stdin);
  // FFmpeg may quit first (a skip, say); the pipe into it then just closes.
  converter.stdin.on("error", () => {});
  converter.stderr.setEncoding("utf8").on("data", (chunk: string) => log.warn(`music: ffmpeg: ${chunk.trim().slice(0, 300)}`));
  converter.on("error", (error) => log.error(`music: could not run ffmpeg: ${error.message}`));
  return {
    stream: converter.stdout,
    type: StreamType.OggOpus,
    close() {
      fetching.close();
      endProcess(converter);
    },
  };
}

export type Finished = { stdout: string; stderr: string; code: number | null };
export type Runner = (command: string, args: string[], timeoutMs: number) => Promise<Finished>;

/** Runs a program to its end and keeps what it printed; never through a shell. */
export const run: Runner = (command, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < 1_000_000) stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < 10_000) stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });

/** Whether a program is on the PATH, the way the system looks for one, without running it. */
export function onPath(command: string, env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): boolean {
  const path = env.PATH ?? env.Path ?? "";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  return path
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => extensions.some((extension) => exists(join(dir, command + extension))));
}

/**
 * The two programs: undefined for one that is not on the PATH, else its version, or
 * "(version unknown)" when it was found but did not answer in time.
 */
export async function toolVersions(
  runner: Runner = run,
  found: (command: string) => boolean = (command) => onPath(command),
): Promise<{ ytdlp?: string; ffmpeg?: string }> {
  const version = async (command: string, args: string[], pick: RegExp) => {
    if (!found(command)) return undefined;
    try {
      const { stdout, code } = await runner(command, args, VERSION_TIMEOUT_MS);
      const match = stdout.match(pick);
      return (code === 0 && match ? match[1] : undefined) ?? "(version unknown)";
    } catch {
      return "(version unknown)";
    }
  };
  return {
    ytdlp: await version(YTDLP, ["--version"], /^(\S+)/m),
    ffmpeg: await version(FFMPEG, ["-version"], /^ffmpeg version (\S+)/m),
  };
}
