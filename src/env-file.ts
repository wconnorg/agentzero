/**
 * Editing the text of an env file the way Node reads it (`--env-file`): one `KEY=value` per
 * line, `export KEY=value` allowed, `#` for comments, and when a key is there more than once
 * the LAST line is the one Node uses. Pure, so the tests run it exactly as
 * scripts/new-secret.ts does.
 */

export type EnvEdit =
  | { ok: true; text: string }
  /** The key is on several lines (1-based numbers); nothing was changed. */
  | { ok: false; lines: number[] };

/**
 * Sets `key` to `value`: replaces the key's one line, or adds a line at the end when there
 * is none, keeping the file's line endings. A key on several lines is refused rather than
 * guessed at: rewriting the wrong one would leave Node reading the old value.
 */
export function setEnvLine(text: string, key: string, value: string): EnvEdit {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const isKeyLine = new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=`);

  const found = lines.flatMap((line, index) => (isKeyLine.test(line) ? [index] : []));
  if (found.length > 1) return { ok: false, lines: found.map((index) => index + 1) };

  const [index] = found;
  if (index === undefined) {
    if (lines.at(-1) === "") lines.pop();
    lines.push(`${key}=${value}`, "");
  } else {
    lines[index] = `${key}=${value}`;
  }
  return { ok: true, text: lines.join(newline) };
}
