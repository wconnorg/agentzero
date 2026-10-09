/**
 * Music, the pure part: what a member asked for, the queue, and how a track is shown.
 * Fetching a track is ytdlp.ts; playing it is music.ts.
 */

export type Track = {
  title: string;
  /** Seconds; 0 when unknown (a live stream, say). */
  duration: number;
  /** The page the track came from: shown, and fetched again when it plays. */
  url: string;
  /** Whether yt-dlp hands over Opus in WebM, which Discord takes as is, or FFmpeg must convert. */
  format: "webm-opus" | "other";
  /** The Discord id of who asked. */
  requestedBy: string;
};

export type Request =
  | { kind: "url"; url: string }
  | { kind: "spotify"; url: string }
  | { kind: "search"; query: string }
  /** A link to a site the bot does not play from; the reply says which it does. */
  | { kind: "other-link"; host: string };

const MAX_REQUEST = 300;

/**
 * The sites a pasted link may point at (a search goes to YouTube anyway). A list of names,
 * rather than a check on the name, because any name can lead anywhere: a public name can
 * resolve to this computer or the home network, and a page can redirect there. Add a site
 * here (the README's "Changing things" says so); its subdomains come along.
 */
export const ALLOWED_HOSTS: readonly string[] = [
  "youtube.com",
  "youtu.be",
  "soundcloud.com",
  "bandcamp.com",
  "vimeo.com",
  "mixcloud.com",
  "open.spotify.com",
];

/** Whether a link is to one of the allowed sites, over HTTPS or HTTP. */
export function isAllowedLink(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/** A link to play, a Spotify link to look up, or words to search YouTube for; nothing usable gives undefined. */
export function parseRequest(text: string): Request | undefined {
  const cleaned = text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_REQUEST);
  if (!cleaned) return undefined;
  if (!/^https?:\/\/\S+$/i.test(cleaned)) return { kind: "search", query: cleaned };
  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    return undefined;
  }
  if (!isAllowedLink(url.href)) return { kind: "other-link", host: url.hostname };
  if (url.hostname === "open.spotify.com") return { kind: "spotify", url: url.href };
  return { kind: "url", url: url.href };
}

/** 3:07, 1:02:45, or "live" for no known length. */
export function formatDuration(seconds: number): string {
  if (!(seconds > 0)) return "live";
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/** How a track is named in replies: its title, kept from formatting the message, and its length. */
export const describe = (track: Track) => `**${track.title.replace(/([*_~`|\\])/g, "\\$1")}** (${formatDuration(track.duration)})`;

/** What played and what is to come, with one cursor; the played stay so `previous` can go back. */
export type Queue<T> = {
  /** Adds at the end; returns how many are ahead of it (0: it is the current one now). */
  add(item: T): number;
  current(): T | undefined;
  /** Moves on; undefined once everything has played. */
  next(): T | undefined;
  /** Whether `previous` has anything to go to. */
  hasPrevious(): boolean;
  /** Back to the one before the current, or the last one once everything has played. */
  previous(): T | undefined;
  upcoming(): T[];
  clear(): void;
};

/** How many played tracks are kept for `previous`. */
const HISTORY = 50;

export function createQueue<T>(): Queue<T> {
  const items: T[] = [];
  /** The current item; items.length once everything has played, -1 before anything was added. */
  let at = -1;
  return {
    add(item) {
      items.push(item);
      if (at < 0 || at >= items.length - 1) {
        at = items.length - 1;
        return 0;
      }
      // Only the last few played ones are kept.
      if (at > HISTORY) {
        items.splice(0, at - HISTORY);
        at = HISTORY;
      }
      return items.length - 1 - at;
    },
    current: () => (at >= 0 ? items[at] : undefined),
    next() {
      if (at < items.length) at++;
      return items[at];
    },
    hasPrevious: () => items.length > 0,
    previous() {
      at = Math.max(0, Math.min(at, items.length) - 1);
      return items[at];
    },
    upcoming: () => (at < 0 ? [...items] : items.slice(at + 1)),
    clear() {
      items.length = 0;
      at = -1;
    },
  };
}
