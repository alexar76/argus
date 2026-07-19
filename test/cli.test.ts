import { describe, it, expect } from "vitest";
import { parse } from "../src/cli/args.js";
import { main } from "../src/cli.js";

describe("cli args", () => {
  it("defaults cmd to help when argv is empty", () => {
    expect(parse(["node", "argus"])).toEqual({ cmd: "help", rest: [], flags: {} });
  });

  it("parses command, positional rest, and value flags", () => {
    expect(parse(["node", "argus", "ask", "hello", "world", "--budget", "3", "--yes"])).toEqual({
      cmd: "ask",
      rest: ["hello", "world"],
      flags: { budget: "3", yes: true },
    });
  });

  it("treats bare boolean flags as true", () => {
    expect(parse(["node", "argus", "doctor", "--verbose"]).flags).toEqual({ verbose: true });
  });

  it("does not consume the next token as a flag value when it is another flag", () => {
    expect(parse(["node", "argus", "verify", "bundle.json", "--proof", "--json", "{}"]).flags).toEqual({
      proof: true,
      json: "{}",
    });
  });
});

describe("cli entry", () => {
  it("re-exports main from the modular cli package", () => {
    expect(typeof main).toBe("function");
  });
});
