import { expect, test } from "bun:test";
import { isSafeCommand } from "./utils.ts";

test("rejects commands that can mutate, execute, or span multiple lines", () => {
  for (const command of [
    "find . -delete",
    String.raw`find . -exec echo unsafe \;`,
    `awk 'BEGIN{system("echo unsafe")}'`,
    "env node -e 'process.exit(0)'",
    "curl -X POST https://example.com",
    "wget https://example.com/file",
    String.raw`cat README.md
pwd`,
  ]) {
    expect(isSafeCommand(command)).toBe(false);
  }
});

test("keeps ordinary read-only exploration commands allowed", () => {
  for (const command of [
    "rg -n TODO src",
    "fd -t f .",
    "git status --short",
    "cat README.md | head -20",
  ]) {
    expect(isSafeCommand(command)).toBe(true);
  }
});
