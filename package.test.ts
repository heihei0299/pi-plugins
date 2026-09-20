import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";

const manifestPath = new URL("./package.json", import.meta.url);

function readManifest(): Record<string, any> {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

test("declares the repository as a Pi package with every extension", () => {
  const exists = existsSync(manifestPath);
  expect(exists).toBe(true);
  if (!exists) return;

  const manifest = readManifest();
  expect(manifest.keywords).toContain("pi-package");
  expect(manifest.pi.extensions).toEqual([
    "./native-responses-web-search/index.ts",
    "./jev/index.ts",
    "./pi-locked-subagents/index.ts",
    "./pi-plan-mode/index.ts",
    "./pi-context-audit/index.ts",
  ]);
  expect(manifest.peerDependencies).toMatchObject({
    "@earendil-works/pi-agent-core": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    typebox: "*",
  });
  expect(manifest.peerDependencies).not.toHaveProperty("@sinclair/typebox");
});

test("does not keep the obsolete CLIProxyAPI native plugin", () => {
  expect(existsSync(new URL("./cpa-plugin-muse-spark/", import.meta.url))).toBe(false);
});
