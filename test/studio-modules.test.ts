import { describe, it, expect } from "vitest";
import { STUDIO_VERBS as fromIndex } from "../src/studio/index.js";
import { STUDIO_VERBS as fromRegistry } from "../src/studio/registry.js";
import { platonVerbs } from "../src/studio/verbs/platon.js";
import { landauerVerbs } from "../src/studio/verbs/landauer.js";

describe("studio modular registry", () => {
  it("index and registry export the same frozen verb map", () => {
    expect(fromIndex).toBe(fromRegistry);
    expect(Object.isFrozen(fromIndex)).toBe(true);
  });

  it("verb modules merge into the registry without key collisions", () => {
    expect(Object.keys(platonVerbs).sort()).toEqual(["beacon", "coin", "winner"]);
    expect(Object.keys(landauerVerbs)).toEqual(["compute-floor"]);
    for (const verb of Object.keys(platonVerbs)) {
      expect(fromRegistry[verb]?.capabilityId).toBe(platonVerbs[verb]!.capabilityId);
    }
  });
});
