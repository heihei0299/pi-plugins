import { expect, test } from "bun:test";
import {
  ALLOWED_ENV,
  DEPTH_ENV,
  childEnvironment,
  parseConfig,
} from "./config.ts";

test("does not inherit arbitrary parent credentials by default", () => {
  const env = childEnvironment(
    { model: "test/model" },
    {
      PATH: "/bin",
      HOME: "/home/test",
      PARENT_SECRET: "do-not-copy",
      OPENAI_API_KEY: "do-not-copy",
    },
    false,
    1,
  );

  expect(env).toMatchObject({
    PATH: "/bin",
    HOME: "/home/test",
    [ALLOWED_ENV]: "",
    [DEPTH_ENV]: "1",
  });
  expect(env.PARENT_SECRET).toBeUndefined();
  expect(env.OPENAI_API_KEY).toBeUndefined();
});

test("passes explicitly configured provider credentials", () => {
  const env = childEnvironment(
    { model: "test/model", env: ["OPENAI_API_KEY"] },
    {
      PATH: "/bin",
      OPENAI_API_KEY: "provider-key",
      PARENT_SECRET: "do-not-copy",
    },
    false,
    1,
  );

  expect(env.OPENAI_API_KEY).toBe("provider-key");
  expect(env.PARENT_SECRET).toBeUndefined();
});

test("validates environment variable names in agent configuration", () => {
  expect(() => parseConfig(JSON.stringify({
    agents: { worker: { model: "test/model", env: ["OPENAI_API_KEY", ""] } },
  }))).toThrow("env must be an array of environment variable names");
});
