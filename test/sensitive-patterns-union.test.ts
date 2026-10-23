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

describe("which calls need the owner's approval", () => {
  it("an MCP tool is matched by its exposed name and by the server's own name for it", async () => {
    const { needsApproval } = await import("../src/core/agent.js");
    const policy = { blockAtSeverity: "high" as const, sensitiveToolPatterns: ["delete_*"], allowUnknownServers: false, pinToolDefs: true } as any;
    expect(needsApproval("fs__delete_file", { kind: "mcp", server: "fs" }, policy)).toBe(true);
    expect(needsApproval("fs__read_file", { kind: "mcp", server: "fs" }, policy)).toBe(false);
    expect(needsApproval("delete_note", { kind: "builtin" }, policy)).toBe(true);
    // A built-in whose name merely contains "__" is never read as a server prefix.
    expect(needsApproval("x__delete_file", { kind: "builtin" }, policy)).toBe(false);
  });
});
