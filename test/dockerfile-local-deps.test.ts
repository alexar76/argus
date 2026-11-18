// The ARGUS image installs its dependencies with `npm ci` (build stage) and `npm install --omit=dev` (runtime stage)
// from package.json and package-lock.json alone. A dependency or override that points at a local file
// ("file:third_party/picomatch-4.0.8.tgz") makes both fail with ENOENT unless the Dockerfile copies that path in
// first: on 2026-11-18 the patched picomatch override broke the build that way. This test keeps them together.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** Every local path package.json installs from: dependencies of each kind and overrides. */
function localPaths(pkg: Record<string, any>): string[] {
  const specs: string[] = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides"]) {
    const walk = (v: unknown) => {
      if (typeof v === "string") specs.push(v);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(pkg[field]);
  }
  return [...new Set(specs.filter((s) => s.startsWith("file:")).map((s) => s.slice("file:".length).replace(/^\.\//, "")))];
}

/** The paths a stage copies (COPY <src> <dest>, not --from) before its first `RUN npm …` install. */
function copiedBeforeInstall(stage: string, install: RegExp): string[] {
  const lines = stage.split("\n");
  const at = lines.findIndex((l) => install.test(l));
  expect(at, `no ${install} in this stage`).toBeGreaterThan(-1);
  return lines.slice(0, at).filter((l) => /^COPY\s/.test(l) && !/--from=/.test(l))
    .flatMap((l) => l.trim().split(/\s+/).slice(1, -1));
}

describe("the Dockerfile copies every local file dependency before npm installs", () => {
  const pkg = JSON.parse(read("package.json"));
  const dockerfile = read("Dockerfile");
  const [, build, runtime] = dockerfile.split(/^FROM\s/m);
  const local = localPaths(pkg);
  const covered = (copied: string[], path: string) =>
    copied.some((c) => path === c || path.startsWith(`${c.replace(/\/+$/, "")}/`));

  it("finds the stages and the local paths", () => {
    expect(build).toMatch(/AS build/);
    expect(runtime).toMatch(/AS runtime/);
    expect(local.length).toBeGreaterThan(0);
  });

  it("build stage: each local path is copied before npm ci", () => {
    const copied = copiedBeforeInstall(build, /^RUN npm ci\b/);
    expect(local.filter((p) => !covered(copied, p))).toEqual([]);
  });

  it("runtime stage: each local path is copied before npm install", () => {
    const copied = copiedBeforeInstall(runtime, /^RUN npm install\b/);
    expect(local.filter((p) => !covered(copied, p))).toEqual([]);
  });
});
