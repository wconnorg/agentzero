import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setEnvLine } from "./env-file.ts";

const KEY = "INTERNAL_API_SECRET";
const NEW = "new-value";

const edited = (text: string) => {
  const result = setEnvLine(text, KEY, NEW);
  assert.ok(result.ok, "expected the edit to be made");
  return result.text;
};

describe("setEnvLine", () => {
  it("replaces the key's line and leaves every other line alone", () => {
    const text = `DISCORD_TOKEN=token\n${KEY}=old-value\nGUILD_ID=1\n`;
    assert.equal(edited(text), `DISCORD_TOKEN=token\n${KEY}=${NEW}\nGUILD_ID=1\n`);
  });

  it("fills in the empty placeholder from .env.example", () => {
    assert.equal(edited(`${KEY}=\n`), `${KEY}=${NEW}\n`);
  });

  it("keeps Windows line endings", () => {
    assert.equal(edited(`A=1\r\n${KEY}=old\r\nB=2\r\n`), `A=1\r\n${KEY}=${NEW}\r\nB=2\r\n`);
  });

  it("adds the key at the end when it is missing, with or without a final newline", () => {
    assert.equal(edited("A=1\n"), `A=1\n${KEY}=${NEW}\n`);
    assert.equal(edited("A=1"), `A=1\n${KEY}=${NEW}\n`);
    assert.equal(edited(""), `${KEY}=${NEW}\n`);
  });

  it("finds the key written the other ways Node accepts", () => {
    assert.equal(edited(`export ${KEY}=old\n`), `${KEY}=${NEW}\n`);
    assert.equal(edited(`  ${KEY} = old\n`), `${KEY}=${NEW}\n`);
  });

  it("does not take a comment or a longer name for the key", () => {
    const text = `# ${KEY}=example\nOLD_${KEY}=1\n${KEY}_BACKUP=2\n`;
    assert.equal(edited(text), `${text}${KEY}=${NEW}\n`);
  });

  it("refuses a key that is on several lines, naming them, and changes nothing", () => {
    // Node reads the last line: rewriting the placeholder would leave the old value in use.
    const text = `A=1\n${KEY}=\nB=2\n${KEY}=old-value\n`;
    assert.deepEqual(setEnvLine(text, KEY, NEW), { ok: false, lines: [2, 4] });
    assert.deepEqual(setEnvLine(`${KEY}=a\nexport ${KEY}=b\n ${KEY} =c\n`, KEY, NEW), { ok: false, lines: [1, 2, 3] });
  });

  it("never puts the old value in its answer", () => {
    const result = setEnvLine(`${KEY}=old-secret-value\n`, KEY, NEW);
    assert.ok(!JSON.stringify(result).includes("old-secret-value"));
  });
});
