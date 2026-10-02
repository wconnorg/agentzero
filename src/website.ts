import { SNOWFLAKE } from "./config.ts";

/**
 * The client for zerocorps.org's internal API (the contract is docs/INTERNAL-API.md in
 * the website's repository). Every call carries the shared secret in `X-Internal-Secret`.
 *
 * Every answer is checked before anything acts on it: a failed or malformed answer
 * throws, and the caller changes nothing. When the website says to slow down (429), or
 * Vercel's firewall blocks the bot (403), every call pauses for a while without touching
 * the website, so a burst of joins cannot hammer it.
 */

export type RankEntry = { discordId: string; rank: string | null };

/** Only the rank is kept from a profile; the ZeroCorps username is not needed here. */
export type Profile = { linked: false } | { linked: true; rank: string | null };

export type Website = {
  ranks(): Promise<RankEntry[]>;
  profile(discordId: string): Promise<Profile>;
};

export type WebsiteErrorKind =
  | "network"
  | "unauthorized"
  | "firewall"
  | "rate_limited"
  | "paused"
  | "disabled"
  | "bad_request"
  | "unexpected";

export class WebsiteError extends Error {
  override name = "WebsiteError";
  readonly kind: WebsiteErrorKind;
  /** How long the website (or the pause) says to wait before calling again. */
  readonly retryAfterMs: number | undefined;

  constructor(kind: WebsiteErrorKind, message: string, retryAfterMs?: number) {
    super(message);
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

const TIMEOUT_MS = 15_000;
const FIREWALL_PAUSE_MS = 10 * 60_000;
const DEFAULT_RATE_LIMIT_PAUSE_MS = 60_000;
const MAX_PAUSE_MS = 60 * 60_000;

type Options = {
  origin: string;
  secret: string;
  fetch?: typeof fetch;
  now?: () => number;
};

export function createWebsite({ origin, secret, fetch: fetchImpl = fetch, now = Date.now }: Options): Website {
  let pausedUntil = 0;

  function pause(ms: number) {
    pausedUntil = Math.max(pausedUntil, now() + ms);
  }

  /** GETs `path` and returns the parsed body for the statuses in `accept`; throws otherwise. */
  async function get(path: string, accept: readonly number[]): Promise<{ status: number; body: unknown }> {
    const wait = pausedUntil - now();
    if (wait > 0) {
      throw new WebsiteError("paused", `holding off calling the website for ${seconds(wait)}`, wait);
    }

    let response: Response;
    try {
      response = await fetchImpl(new URL(path, origin), {
        headers: { "x-internal-secret": secret, accept: "application/json" },
        // A redirect would carry the secret header to another address: never follow one.
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      // fetch quotes a malformed header value back in its error: keep the secret out of logs.
      const reason = describe(error).split(secret).join("[the secret]");
      throw new WebsiteError("network", `could not reach ${origin} (${reason})`);
    }
    const text = await response.text().catch(() => "");
    const body = parseJson(text);
    const { status } = response;

    if (accept.includes(status)) return { status, body };

    switch (status) {
      case 401:
        throw new WebsiteError(
          "unauthorized",
          "the website refused the secret (401): INTERNAL_API_SECRET in .env differs from Vercel's " +
            "(Production). Run `npm run secret:new`, paste it over Vercel's value, then redeploy " +
            "(Deployments, then Redeploy).",
        );
      case 403: {
        pause(FIREWALL_PAUSE_MS);
        const checkpoint = /vercel security checkpoint/i.test(text) ? " Security Checkpoint" : "";
        throw new WebsiteError(
          "firewall",
          `Vercel's firewall blocked the bot (403${checkpoint}). Owner: in the Vercel project's ` +
            "Firewall, switch off the challenge on automated requests or add a rule letting " +
            `/api/internal/ through. The bot tries again in ${seconds(FIREWALL_PAUSE_MS)}.`,
          FIREWALL_PAUSE_MS,
        );
      }
      case 429: {
        const wait = retryAfterMs(body, response.headers);
        pause(wait);
        throw new WebsiteError(
          "rate_limited",
          `the website asked the bot to slow down (429); waiting ${seconds(wait)}`,
          wait,
        );
      }
      case 503:
        if (isObject(body) && body.error === "disabled") {
          throw new WebsiteError(
            "disabled",
            "the website's internal API is off (503): INTERNAL_API_SECRET is not set on Vercel, " +
              "or the site has not been redeployed since it was set",
          );
        }
        break;
      case 400:
        throw new WebsiteError("bad_request", `the website refused the request for ${path} as malformed (400)`);
    }
    throw new WebsiteError("unexpected", `the website answered HTTP ${status} for ${path}`);
  }

  return {
    async ranks() {
      const { body } = await get("/api/internal/discord/ranks", [200]);
      if (!isObject(body) || !Array.isArray(body.members)) throw malformed("ranks");
      // One bad entry rejects the whole list: a sync must never act on half an answer.
      return body.members.map((member: unknown): RankEntry => {
        if (
          !isObject(member) ||
          typeof member.discordId !== "string" ||
          !SNOWFLAKE.test(member.discordId) ||
          !isRank(member.rank)
        ) {
          throw malformed("ranks");
        }
        return { discordId: member.discordId, rank: member.rank };
      });
    },

    async profile(discordId) {
      if (!SNOWFLAKE.test(discordId)) {
        throw new WebsiteError("bad_request", "not a Discord id; the website was not called");
      }
      const { status, body } = await get(`/api/internal/discord/${discordId}/profile`, [200, 404]);
      if (status === 404) {
        // Any other 404 (an HTML page, say) means the API is not where the bot expects it.
        if (isObject(body) && body.linked === false) return { linked: false };
        throw malformed("profile");
      }
      if (!isObject(body) || body.linked !== true || !isRank(body.rank)) throw malformed("profile");
      return { linked: true, rank: body.rank };
    },
  };
}

const malformed = (what: string) =>
  new WebsiteError("unexpected", `the website's ${what} answer was not in the expected shape; nothing was changed`);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRank = (value: unknown): value is string | null => value === null || typeof value === "string";

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The body's `retryAfterSeconds`, else the `Retry-After` header, else a minute; at most an hour. */
function retryAfterMs(body: unknown, headers: Headers): number {
  const fromBody = isObject(body) ? body.retryAfterSeconds : undefined;
  const fromHeader = Number(headers.get("retry-after"));
  const secondsToWait =
    typeof fromBody === "number" && fromBody > 0 ? fromBody : fromHeader > 0 ? fromHeader : undefined;
  const ms = secondsToWait === undefined ? DEFAULT_RATE_LIMIT_PAUSE_MS : Math.ceil(secondsToWait * 1000);
  return Math.min(Math.max(ms, 1000), MAX_PAUSE_MS);
}

const seconds = (ms: number) => `${Math.ceil(ms / 1000)}s`;

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === "TimeoutError") return `no answer within ${seconds(TIMEOUT_MS)}`;
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}
