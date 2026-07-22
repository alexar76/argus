import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseEnvFile, loadWorkspaceEnv } from "../src/env-file.js";

describe("env-file", () => {
  it("parses comments, blanks, and quoted values", () => {
    const m = parseEnvFile(`
# comment
DEEPSEEK_API_KEY=sk-abc
ARGUS_TELEGRAM_TOKEN="719:AA-token"
QUOTED='single'
`);
    expect(m.get("DEEPSEEK_API_KEY")).toBe("sk-abc");
    expect(m.get("ARGUS_TELEGRAM_TOKEN")).toBe("719:AA-token");
    expect(m.get("QUOTED")).toBe("single");
  });

  describe("loadWorkspaceEnv", () => {
    let dir: string;
    const prev = { cwd: process.cwd(), env: { ...process.env } };

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "argus-env-"));
      process.chdir(dir);
      delete process.env.DEEPSEEK_API_KEY;
      delete process.env.ARGUS_TELEGRAM_TOKEN;
      delete process.env.ARGUS_ENV_FILE;
      delete process.env.ARGUS_HOME;
    });

    afterEach(() => {
      process.chdir(prev.cwd);
      process.env = prev.env;
      rmSync(dir, { recursive: true, force: true });
    });

    it("loads cwd .env into process.env", () => {
      writeFileSync(join(dir, ".env"), "DEEPSEEK_API_KEY=from-file\nARGUS_TELEGRAM_TOKEN=tg123\n");
      const loaded = loadWorkspaceEnv();
      expect(loaded.some((p) => p.endsWith(".env"))).toBe(true);
      expect(process.env.DEEPSEEK_API_KEY).toBe("from-file");
      expect(process.env.ARGUS_TELEGRAM_TOKEN).toBe("tg123");
    });

    it("does not override existing shell exports", () => {
      process.env.DEEPSEEK_API_KEY = "from-shell";
      writeFileSync(join(dir, ".env"), "DEEPSEEK_API_KEY=from-file\n");
      loadWorkspaceEnv();
      expect(process.env.DEEPSEEK_API_KEY).toBe("from-shell");
    });
  });
});
