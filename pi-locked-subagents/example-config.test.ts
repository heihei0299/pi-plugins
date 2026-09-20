import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseConfig } from "./config.ts";

const exampleConfig = readFileSync(new URL("./locked-subagents.example.json", import.meta.url), "utf8");

test("the example locked-subagents configuration is valid and semantically usable", () => {
  expect(() => JSON.parse(exampleConfig)).not.toThrow();
  expect(() => parseConfig(exampleConfig)).not.toThrow();

  const config = parseConfig(exampleConfig);
  expect(config.agents.reviewer?.allowedAgents ?? []).toEqual([]);
  expect(config.agents.reviewer?.tools ?? []).not.toContain("subagent");
});
