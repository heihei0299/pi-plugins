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
    "./pi-locked-subagents/index.ts",
    "./pi-plan-mode/index.ts",
  ]);
  expect(manifest.peerDependencies).toMatchObject({
    "@earendil-works/pi-agent-core": "0.85.1",
    "@earendil-works/pi-ai": "0.85.1",
    "@earendil-works/pi-coding-agent": "0.85.1",
    "@earendil-works/pi-tui": "0.85.1",
    "@sinclair/typebox": "0.34.52",
    typebox: "1.3.31",
  });
});

test("does not keep the obsolete CLIProxyAPI native plugin", () => {
  expect(existsSync(new URL("./cpa-plugin-muse-spark/", import.meta.url))).toBe(false);
});
