import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseConfig } from "./config.ts";

const exampleConfig = readFileSync(new URL("./locked-subagents.example.json", import.meta.url), "utf8");
const previousAllowedAgents = process.env.PI_LOCKED_SUBAGENT_ALLOWED;
process.env.PI_LOCKED_SUBAGENT_ALLOWED = "worker";

afterAll(() => {
  if (previousAllowedAgents === undefined) delete process.env.PI_LOCKED_SUBAGENT_ALLOWED;
  else process.env.PI_LOCKED_SUBAGENT_ALLOWED = previousAllowedAgents;
});

test("the example locked-subagents configuration is valid and semantically usable", () => {
  const ambientAllowedAgents = process.env.PI_LOCKED_SUBAGENT_ALLOWED;
  delete process.env.PI_LOCKED_SUBAGENT_ALLOWED;
  try {
    expect(() => JSON.parse(exampleConfig)).not.toThrow();
    expect(() => parseConfig(exampleConfig)).not.toThrow();

    const config = parseConfig(exampleConfig);
    expect(config.agents.reviewer?.allowedAgents ?? []).toEqual([]);
    expect(config.agents.reviewer?.tools ?? []).not.toContain("subagent");
  } finally {
    if (ambientAllowedAgents === undefined) delete process.env.PI_LOCKED_SUBAGENT_ALLOWED;
    else process.env.PI_LOCKED_SUBAGENT_ALLOWED = ambientAllowedAgents;
  }
});
