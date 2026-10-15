// A config file must never shrink the list of tools that need the owner's approval.
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("sensitive tool patterns", () => {
  it("a file that lists fewer patterns still keeps every built-in spend pattern", async () => {
    const dir = mkdtempSync(join(tmpdir(), "argus-cfg-"));
    const path = join(dir, "argus.config.json");
    writeFileSync(path, JSON.stringify({ warden: { sensitiveToolPatterns: ["*delete*", "*custom*"] } }));
    const { loadConfig } = await import("../src/config.js");
    const { config } = loadConfig(path);
    for (const p of ["*invoke*", "*buy*", "*spend*", "*withdraw*", "*custom*"]) {
      expect(config.warden.sensitiveToolPatterns).toContain(p);
    }
  });

  it("the shipped example lists every built-in pattern", async () => {
    const { readFileSync } = await import("node:fs");
    const example = JSON.parse(readFileSync(join(__dirname, "..", "argus.config.example.json"), "utf8"));
    for (const p of ["*invoke*", "*trade*", "*swap*", "*buy*", "*enter*", "*spend*", "*approve*", "*withdraw*"]) {
      expect(example.warden.sensitiveToolPatterns).toContain(p);
    }
  });
});
