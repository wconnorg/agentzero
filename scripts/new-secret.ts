// npm run secret:new
//
// Makes a new INTERNAL_API_SECRET, writes it into .env (replacing the old one) and puts it
// on the clipboard for pasting into Vercel. It never shows the value. The website's copy
// must then be replaced with the same value, or the bot gets 401s.
//
// Save and close .env in your editor before running this.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setEnvLine } from "../src/env-file.ts";

const ENV_FILE = new URL("../.env", import.meta.url);
const KEY = "INTERNAL_API_SECRET";

if (!existsSync(ENV_FILE)) {
  console.error("There is no .env yet: copy .env.example to .env first.");
  process.exit(1);
}

// This script does not load .env, so a value here was set in the terminal itself, and the
// bot would use it instead of the one in .env.
if (process.env[KEY] !== undefined) {
  console.error(
    `${KEY} is also set in this terminal's own environment, which the bot would use instead of .env.\n` +
      "Open a new terminal (or remove that variable) and run this again. Nothing was changed.",
  );
  process.exit(1);
}

// 32 random bytes as base64url: 43 characters, none of which need quoting in a .env file.
const secret = randomBytes(32).toString("base64url");

const edit = setEnvLine(readFileSync(ENV_FILE, "utf8"), KEY, secret);
if (!edit.ok) {
  const last = edit.lines.at(-1);
  console.error(
    `${KEY} is on lines ${edit.lines.slice(0, -1).join(", ")} and ${last} of .env, and the bot reads only the last one.\n` +
      "Delete all but one of those lines, save, and run this again. Nothing was changed.",
  );
  process.exit(1);
}
writeFileSync(ENV_FILE, edit.text);

const clipboard = process.platform === "win32" ? "clip" : process.platform === "darwin" ? "pbcopy" : undefined;
let copied = false;
if (clipboard) {
  try {
    execFileSync(clipboard, { input: secret });
    copied = true;
  } catch {
    // No clipboard: the owner copies it from .env instead.
  }
}

console.log(`Wrote a new ${KEY} to .env (not shown).`);
console.log(
  copied
    ? "It is also on your clipboard, ready to paste into Vercel."
    : `Copy the ${KEY} value from .env to paste into Vercel.`,
);
console.log(`
Next:
  1. Vercel: the zerocorps project, Settings, Environment Variables, ${KEY}, Edit.
     Paste the new value (replacing the old one) and save.
  2. Redeploy the site: a new value only takes effect in a new deployment.
  3. Restart the bot.
  4. Copy something else to clear the clipboard. If Windows clipboard history (Win+V)
     is on, delete the entry there too.`);
