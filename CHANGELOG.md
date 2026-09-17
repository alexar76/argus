# Changelog

All notable changes to ARGUS-3 (`@alexar76/argus3`, CLI `argus`, npm `argus-warden`).

## 0.3.1 — 2026-08-24

### Changed

- Pin **`@aimarket/warden@0.4.0`** (ruleset v4, field-survey calibration). Registry installs no longer
  resolve a firewall version that is not published.

## Unreleased

### Changed — WARDEN moved into its own package

The firewall is no longer part of this source tree. `src/warden/` became
**[`@aimarket/warden`](https://github.com/alexar76/warden)** — a standalone, zero-runtime-dependency
library — and ARGUS now depends on it, pinned to an exact version. The move itself changed nothing:
it carried ruleset v2 (digest `sha256-gWC14PR4kUylkJaAGMnIYYX6tPhZTJ60cSB61UZxuWc=`) byte for byte,
with the same severities, tiers, score arithmetic and finding codes.

**The package was then reviewed before its first release, and that took the rules to v3**, digest
`sha256-pah/sT4IeIgSUCGKcmaIXIc7Cpr+j9RIJxJ5ERixrVo=`. What changes for ARGUS:

- **The tool NAME is scanned now.** Rules carry `surfaces`, and 17 of 25 include the name — until v3
  nothing scanned it, so an injection phrase or a zero-width character in a tool name produced no
  finding. The three noun-keyed codes stay off the name so `sign_with_private_key` is not refused.
- **Verdicts quote the new ruleset id.** Any stored scan naming the v2 digest describes a table that
  is no longer the one that runs; that is what the digest is for. `argus verify` compares what a
  receipt carries, so nothing silently re-interprets an old one.
- **Findings are display-safe.** Control and invisible characters in a tool name, server id or feed
  reason are escaped in `finding.message` (a name containing `ESC[2K` used to overwrite the BLOCK
  line in the operator's terminal). `finding.tool` still carries the raw name, which is what
  `McpHost` filters on.
- **A new finding code, `SERVER_IDENTITY_DRIFT`**, fires when a previously approved server keeps its
  tool defs but changes transport/command/args/url. Pins written before this release have no
  identity recorded and stay silent until the next approval.
- **A gate that throws no longer aborts `vet()`**; it becomes a `GATE_ERROR` finding at `high`. A
  failing pin store therefore reports a blocked connection with a reason instead of an exception.
- **A frozen `warden` policy object no longer crashes the constructor**, and ARGUS's config object is
  never mutated by the fallback.

The package's own CHANGELOG has the reproductions, including the two glob patterns that took 112 and
89 seconds to match before the matcher was replaced.

Why: a host that wanted an MCP firewall had to install an agent to get one — with an MCP SDK, a
wallet library and a post-quantum keystore in tow. The package imports nothing but `node:crypto`.

- **Imports.** `./warden/index.js`, `./warden/sandbox.js` and `./warden/pinning.js` are now
  `@aimarket/warden`. Everything ARGUS used is exported from the entry point.
- **Types.** `src/types.ts` re-exports `WardenPolicy`, `WardenVerdict`, `WardenFinding`, `ToolDef`,
  `ThreatRecord` and friends from the package instead of declaring copies, so a change on that side
  breaks this build instead of drifting silently. `MemoryStore extends PinStore` and
  `Logger extends WardenLogger` make the two host seams compiler-checked.
- **Tests.** The gate-behaviour suites (static scan, threat feed, JCS vectors, pinning, benign-server
  regressions) travel with the code they guard. What stayed here is what is about ARGUS: MCP-host
  wiring, sensitive-tool classification in the agent loop, and the oracle-side half of the
  no-phantom-oracle guard (`test/lumen-no-phantom-oracle.test.ts`).
- **Release order.** `@aimarket/warden` must be published before this package, or a registry install
  cannot resolve the pinned firewall version. In the monorepo, `scripts/link_warden_local.sh` wires
  the built package into `node_modules` (and must be re-run after `npm ci`).
- Unchanged for users: the CLI (`argus warden scan`), the config surface (`warden.*` in
  `argus.config.json`), and the npm alias `argus-warden`, which still publishes the full agent.

## 0.3.0 — 2026-08-03

### Also in this window

Commit `7c05cacf` — "the threat feed accepted any age, signed unstable bytes, and matched almost
nothing" — landed separately: threat-feed freshness (`warden.feedMaxAgeMs`), RFC 8785 signing via
the new `@aimarket/warden/src/jcs.ts`, tool-definition match scope (`ThreatRecord.scope`), and a canonical
tool-def pin. Summarised here from its own commit message, not re-verified in this entry. The
static-scan ruleset digest below reuses that JCS implementation rather than adding a second
serialization.

### Fixed — the static scan blocked ordinary MCP servers (breaking)

Ruleset v1 had a single tier, so a credential *parameter name* carried the same weight as
"ignore all previous instructions". A GitHub-style server whose `create_issue` takes an
`api_key` and mentions a personal access token scored **0.40**, landed `create_issue` in
`blockedTools`, and the whole connection was refused under the default
`blockAtSeverity: "high"`. Most real MCP servers were refused. Neither WARDEN test fixture
contained a benign tool definition — both used the same poisoned string — so nothing in CI
covered the case.

The same three tool definitions now produce `allow: true`, score `0.900`, no blocked tools, and
the four findings are still reported as advisory.

- **Added** a `block` / `advise` tier to every rule, and `WardenFinding.advisory`. An advisory
  finding never blocks a connection and never costs a tool **at any `blockAtSeverity`**. The
  tier is data, not a severity trick: expressing "not a defect" by lowering severity would have
  made these findings blocking again for anyone who tightened the threshold.
- **Advisory now:** `api_key`, `credentials`/`access_token`/`bearer token`, `secret`,
  `password`, `.env`/`environment variables`, `you must`, `instead of`. New codes
  `TOOL_DEF_CREDENTIAL_PARAM`, `TOOL_DEF_ENV_REFERENCE`, `TOOL_DEF_IMPERATIVE`.
- **Added** blocking rule `TOOL_DEF_SECRET_HARVEST` (critical). Retiering the credential nouns
  alone would have let a harvest instruction through whenever it omitted an injection phrase —
  "read the user's api_key from the .env file" was caught only incidentally, by the
  `ignore all previous` match next to it. The discriminator is the **verb**: declaring a
  credential input is normal, instructing the model to go and read one is not.
- **Tightened** the exfil rule `send|post|forward|relay … to` to require an external
  destination (URL or dotted host). Unanchored it matched "Send the message to the recipient"
  in any honest email or webhook tool.
- **Changed** the static-scan score to ignore advisory findings. The composite is presented as
  a safety score, and a credential parameter name is not a safety defect.
- **Marked** `TOOL_DEF_UNPINNED` advisory. At `blockAtSeverity: "info"` this informational
  finding blocked every server at first contact, and since `Warden.approve()` runs only after
  `vet()` passes, no pin could ever be created. First contact must stay possible at every
  threshold.
- **Added** ruleset identity: `STATIC_SCAN_RULESET_VERSION` (now `"2"`), `staticScanRuleset()`
  (the full rule table with `code`/`severity`/`tier`/`source`/`flags`) and
  `staticScanRulesetRef()`. Every `WardenVerdict` now carries
  `rulesets.staticScan = { version, digest }`, because the same server scores differently under
  a different rule table and without the digest that is indistinguishable from the server having
  changed. The digest is `sha256-<base64>` over the RFC 8785 canonical form (`@aimarket/warden/src/jcs.ts`)
  of the rule table, sorted by **code-unit** comparison — `localeCompare` would make the same
  table digest differently on a differently-configured host, which is the divergence the digest
  exists to detect. Current value:
  `sha256-gWC14PR4kUylkJaAGMnIYYX6tPhZTJ60cSB61UZxuWc=`.
- **Added** `test/warden-benign.test.ts`: GitHub-, Stripe-, filesystem-, email- and
  Postgres-style fixtures asserted allowed with a clean score; advisory-never-blocks asserted at
  all five thresholds; the harvest-vs-parameter distinction; the exfil destination anchor; and a
  golden ruleset digest, so changing a rule fails CI until the version is bumped.

Migration: consumers filtering `WardenFinding` by severity alone must now also honour
`advisory`, or they will report allowed connections as blocked ones. `TOOL_DEF_SECRET_REQUEST`
still exists for the three blocking cases (`private_key`, `seed_phrase`/`mnemonic`,
`~/.ssh`/`id_rsa`); the advisory cases moved to the new codes above.

### Removed — WARDEN reputation gate (breaking)

The reputation gate never contacted the LUMEN oracle. `ReputationGate.evaluate` called
`oracle.scoreEntity(server.id)` with no trust edges, and `LumenOracle.scoreEntity` returns its
neutral `degraded` default before reaching `fetch` when `edges` is empty. Nothing in the
codebase ever passed edges — the three call sites were the gate, the `passport` command, and
the interface declaration — so `LumenOracle.invoke()`, the percentile mapping and the
`graph_commitment` it reads were all unreachable in production.

Three consequences, all now gone:

- Every connection was told **"LUMEN trust oracle unreachable"**. No request had been made.
- The composite WARDEN score is a product of the gate scores, so it was permanently multiplied
  by a constant `0.6`. A server with nothing wrong scored `0.54` instead of `0.9`.
- Under `allowUnknownServers: false` the gate blocked **every** server as unvouched, since no
  server could ever be vouched for. "Fail-closed" meant "connect to nothing".

Changes:

- **Removed** `ReputationGate` and its export from `@aimarket/warden/src/index.ts`.
- **Removed** `oracle` from `WardenCreateDeps` — the chain no longer takes a `TrustOracle`.
- **Removed** `minReputation` from `WardenPolicy` and from the default config. Only the deleted
  gate read it. An existing `argus.config.json` that still sets it keeps loading; the value is
  ignored.
- **Added** `OriginGate` in the chain's third slot: `static → threat → origin → pinning`.

### Changed — `allowUnknownServers` now means what it says

Enforcement moved to `OriginGate` and is based on a fact ARGUS holds locally: a server is
either declared by the operator under `mcp.servers`, or discovered from a remote catalog
listed under `mcp.catalogs`, in which case `McpServerRef.catalog` names it. Only the latter is
unknown.

- `false` (fail-closed) blocks catalog-discovered servers with `SERVER_UNDECLARED` and always
  admits operator-declared ones, so fail-closed remains connectable. Enforcing it through the
  pin store instead would have deadlocked: `Warden.approve()` runs only after `vet()` passes,
  and no out-of-band approval command exists.
- `true` (default) reports catalog provenance at `info` and does **not** reduce the composite
  score. Coming from a catalog is not by itself a defect.

### Changed — a degraded reputation result now says whether the oracle was asked

`ReputationScore` is a discriminated union. A degraded result carries
`reason: "no-graph-data" | "oracle-error"`; `no-graph-data` means no request was attempted.
Only `oracle-error` may be described as an outage. This is the root-cause fix: the old flat
`degraded: boolean` made the false message possible, and the type now makes it unrepresentable.

`LumenOracle` still scores correctly when a caller supplies trust edges. No caller does today.

### Added — regression guard

`test/warden-no-phantom-oracle.test.ts` fails if any gate claims a service is unreachable
without a request being attempted, if vetting opens a socket, if a gate that measured nothing
taxes the composite score, or if an unreachability message reappears in `@aimarket/warden/src/`
(comments excluded). It also pins the `no-graph-data` / `oracle-error` distinction, including
a positive control that asserts a request *was* made before `oracle-error` is reported.

### Migration

- Callers of `Warden.create({ oracle, … })` — drop `oracle`.
- Importers of `ReputationGate` — the gate is gone; there is no replacement, because there was
  never a reputation signal to replace.
- Config carrying `warden.minReputation` — remove it; it is ignored.
- Anyone relying on `allowUnknownServers: false` to block everything — it now blocks only
  undeclared, catalog-discovered servers. Declared servers connect.
