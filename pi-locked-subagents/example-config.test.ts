import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const exampleConfig = readFileSync(new URL("./locked-subagents.example.json", import.meta.url), "utf8");

test("the example locked-subagents configuration is valid JSON", () => {
  expect(() => JSON.parse(exampleConfig)).not.toThrow();
});
