# ARGUS-3 — Core capabilities

> 🌐 Language: **English** · [Русский](./killer-features-ru.md) · [Español](./killer-features-es.md)

> Part of the ARGUS-3 documentation set (`argus/docs/`):
> [architecture](./architecture.md) · [security-warden](./security-warden.md) · [economy-integration](./economy-integration.md) · [token-economy](./token-economy.md) · [autonomy](./autonomy.md) · [arena](./arena.md) · **core capabilities**

This document explains the design intent behind ARGUS-3's headline features — what
each one does, who it helps, and which stack components it depends on.

---

## 0. The one idea

Every generic AI agent makes the same two unverifiable promises: *"I'm cheap"* and
*"I'm safe."* You are asked to take both on faith. ARGUS-3's entire thesis is the
opposite:

> **Auditable, not marketing.** Every claim ARGUS-3 makes — what it cost, who it
> trusted, what it refused to do — ships with a proof a stranger can re-check
> **without trusting ARGUS-3, the network, or even AICOM.**

That thesis only holds when two things are true at once:

1. **ARGUS-3 sits on its own metered reasoning** (Layer 2: a hard token+USD budget
   governor with a live meter). It knows, to the cent, what thinking a thought costs.
2. **…and on a priced, reputation-scored market** (Layer 5 + the oracle family). It
   can discover, pay, and be paid — and every counterparty has a *verifiable* trust
   score and signs a *verifiable* receipt.

A generic MCP client has, at most, **one** of those sides. It can call a tool, but it
has no audited cost meter to compare against, and no reputation oracle or escrow
receipt to make any of it provable. The make/buy decision, the proof trail, the
trust score — they exist only where both sides meet. That intersection is ARGUS-3.

---

## 1. The three pillars (the first wave)

The first wave of features is deliberately the **highest-value, lowest-risk** slice —
all ride existing rails, all degrade gracefully with no wallet, none needs new
on-chain code:

- **Close the proof loop.** Make the proofs ARGUS-3 already emits actually
  re-verifiable by an outsider. (`argus verify`, Provenance.)
- **Activate the sleeping assets.** AICOM has seventeen verifiable oracles; today an
  agent touches roughly one. Make all of them effortless to consume. (Oracle Studio.)
- **Turn frugality into an economy.** Don't just *spend* less — decide, per
  sub-task, whether thinking or *buying* is cheaper, and prove the choice.
  (Budget Broker.)

Everything else (the provider/earn side, delegation, portable reputation, the
defensive suite, the new ecosystem services) builds on top of these.

---

## 2. Shipped — wave 1

### `argus verify` — the offline re-verifier  ✅ *the linchpin*
**What:** a tiny, local, network-free command — `argus verify <bundle.json>` — that
re-checks ARGUS-3's proofs with pure cryptography: Ed25519 signatures on oracle
receipts, SHA-256 commitments (e.g. a Percola `graph_commitment`), and the WARDEN
canonical tool-def hash.

**Purpose:** without a verifier *the recipient runs*, "verifiable"
is just a nicer word for "trust me." This is the precondition for every other proof
in the system — Provenance, Passport, FrugalProof, conditional escrow all wave at
"…so a third party can independently re-check," and this is the thing that third
party actually runs. A failing proof is now demonstrably **a claim, not a proof.**

**Stack requirements:** the command is trivial — but it is worthless
without artifacts that are *actually* re-derivable (signed receipts, graph
commitments, canonical hashes). A generic agent can print "verified ✓"; it cannot
hand you the signed pre-images that make the checkmark mean something.

**Crypto-off:** it *is* the crypto-off story — pure local math, no network, no
wallet, by construction. Works the same online or fully offline.

**Status:** shipped. `src/verify/`, `argus verify`, 8 tests.

---

## 3. Shipped — wave 1

### Provenance — the trust trailer on every answer
**What:** any answer that used paid capabilities or oracle reads carries a compact,
collapsible trailer: which providers were called, each one's LUMEN score + graph
commitment *at call time*, whether its TEE/receipt verified, and what it cost.

**Purpose:** "show your work" for trust. You don't just get an
answer — you can unfold *exactly whom the agent trusted to produce it* and re-check
each link with `argus verify`. It is a pure read-side aggregation of artifacts
ARGUS-3 already collects in its observe step, so it costs **zero extra reasoning
tokens** — honesty that is also frugal.

**Stack requirements:** an end-to-end re-verifiable trust chain requires
every dependency to emit a verifiable artifact. A generic agent can log "I called
X"; it cannot let a third party re-prove that X was trustworthy.

**Crypto-off:** the trailer still renders; external links are marked
`unverified (offline)`; a fully local answer reads "answered locally — no external
trust dependencies."

### Oracle Studio — flagship demand for all seventeen oracles
**What:** a friendly layer over `oracle_call` so an ordinary owner uses verifiable
math without knowing a capability id: *flip a fair coin / pick a winner* (Platon
VRF), *prove time elapsed* (Chronos), *even coverage* (Lattice), *robust aggregate*
(Murmuration), *cheapest plan* (Colony), *blue-noise sample* (Turing), *how much to
trust X* (LUMEN), *will this network shatter* (Percola), *the optimal route* (Fermat),
*cascade risk* (Ablation), *the compute floor* (Landauer), *ungrindable verifiable
randomness* (Sortes), *calibrated prediction + best next point* (Gauss), *seal until a
deadline* (Aestus), *the shape of the data* (Betti), *cheapest reshaping plan* (Kantor),
*how well a network connects* (Fourier). Each answer comes with a
foldable verifiable receipt.

**Purpose:** AICOM's most under-used asset is its own oracle family —
sixteen of seventeen sit idle because using them means knowing arcane capability ids.
Oracle Studio is the demand ramp that makes provable math a one-liner, which in turn
feeds LUMEN and ACEX — usage compounds across the stack.

**Stack requirements:** the UX is copyable; the oracles behind the buttons
are not. A plain `Math.random()` coin flip is not a signed, re-verifiable VRF.

**Crypto-off:** free off-chain reads work and render their receipt; paid reads are
greyed "connect wallet"; fully offline, each verb has a clearly-labelled local
fallback (local tie-break, local sampling) — informative, never broken.

### Budget Broker — spend-to-save procurement
**What:** before burning its own tokens on a sub-task, ARGUS-3 estimates the marginal
in-house cost (tokens × tier price, from the live meter) and compares it to the
cheapest Hub capability for the same intent. If buying is cheaper *and* within the
task's USD ceiling, it buys (through the approval-gated `hub_invoke`); otherwise it
reasons locally. Every decision is one auditable line: *"bought X for $0.004 vs
~$0.011 in-house."*

**Purpose:** frugality stops being a vibe and becomes a *decision* —
and a provable one. The agent does the economically right thing on your behalf and
shows its working, with a receipt.

**Stack requirements:** a make/buy frontier needs **both** an audited
in-house cost meter and a budget-scoped, reputation-scored market to buy from. A
generic agent has at most one side, so it can't even compute the comparison, let
alone prove it.

**Crypto-off:** `hub_discover`/`hub_invoke` simply aren't exposed → it silently
degrades to always-make, printing the in-house estimate as an FYI. Never an error.

---

## 4. Shipped — wave 2 (built on wave 1)

- **Provider primitive (G2)** — the minimal *honest* earn rail: serve one inbound
  paid `argus_ask` and emit a verifiable receipt. ARGUS-3 today is a complete
  consumer but a hollow provider; this single primitive unblocks the entire earn
  side (resale, idle-earning, two-sided markets) — so it is the *foundation* to build
  before any earn feature, not another feature on top of a missing rail.
- **Subcontract (A2)** — the twin of Budget Broker: hire another agent for USDC
  *inside one task*, with the sub-cost debited from the **same** budget ceiling, the
  subcontractor LUMEN-vetted before any spend, and the result + escrow receipt
  attached as provenance. Bounded delegation that can't run away with your budget.
- **Passport (A4)** — portable, *verifiable* reputation bound to your Mesh identity:
  a LUMEN score + commitment any counterparty re-derives with `argus verify`. Your
  standing travels across marketplaces because it lives in an oracle, not a silo.
- **Negative attestation (G3)** — the inversion of every proof-of-action: a signed,
  time-anchored guarantee that something **never** happened — *no sensitive tool ran
  without approval, no data left the box, no ceiling was exceeded this session.* The
  exact guarantee a cloud agent (whose vendor sees everything) cannot provide without
  local execution and signed attestations.
- **Defensive suite** — *FrugalProof* (cost receipts anchored by Platon commit-reveal
  + a Chronos time-bound), *Sealed Approval Receipts* (hash-chained, non-repudiable
  consent for every sensitive call), *Drift Sentinel* (catches a tool that changed
  *behavior* without changing its definition — the behavioral complement to pinning).

---

## 5. Staged — ecosystem services (Part B; the Factory builds, ARGUS-3 showcases)

These are net-new components for the Factory to build; ARGUS-3 is their flagship
consumer. The cheapest first (no new Solidity); the chain-heavy ones are deliberately
deferred to a second wave per the principle *"unshipped chain code is a roadmap item,
not a dependency."*

- **Sentinel CI (M, no Solidity)** — continuous health-checks of every Hub listing
  (unpredictable canaries via Murmuration, attested by Turing, time-stamped by
  Chronos). ARGUS-3 reads the CI badge for free at discover-time and refuses to route
  heavy work to a "red" capability; WARDEN treats a green→red flip on a pinned server
  as a drift signal. A shared trust artifact: one agent's private test helps no one;
  a Sentinel badge protects every buyer.
- **Keystone (L, new Solidity)** — conditional escrow that releases **only when an
  oracle confirms the result is real** (`turing.verify`, `lattice.consensus`,
  `chronos`/`platon` deadlines, `lumen.verify`). ARGUS-3 already encodes a success
  criterion in its plan, so it auto-compiles that criterion into the release
  condition — *pay-on-proof* as the default settlement mode.
- **Verdict (L)** — reviews that can't be faked because every star is welded to a
  paid invoke receipt, reviewers are weighted by LUMEN, and herding is blocked by
  Platon commit-reveal.
- **Threat-Intel Commons (L)** — today's static WARDEN deny-list becomes a living,
  signed, LUMEN-weighted commons: when one ARGUS-3 is rugged, every ARGUS-3 is
  inoculated — verifiably.

---

## 6. The non-negotiable: every feature degrades, never errors

A line runs through all of the above: **crypto is off by default, and nothing here
is allowed to become an error when the economy is absent.** Each feature has a
defined behavior with no wallet and with no network — usually "do the local thing
and label the external parts `unverified`." This is what lets ARGUS-3 be a
best-in-class *local* assistant first and an economic actor second, never a broken
one in between. See [autonomy.md](./autonomy.md).

---

## 7. Status at a glance

| Feature | Pillar | Effort | Status |
|---|---|---|---|
| `argus verify` | proof-closure | S | ✅ shipped |
| Provenance | proof-closure | M | ✅ shipped |
| Oracle Studio (`argus oracle`) | activate oracles | M | ✅ shipped |
| Budget Broker (`argus broker`) | make/buy economy | M | ✅ shipped |
| Provider primitive (G2, serving receipt) | earn foundation | M | ✅ shipped |
| Subcontract (`subcontract_invoke`) | make/buy economy | L | ✅ shipped |
| Passport (`argus passport`) | proof-closure | M | ✅ shipped |
| Negative attestation (G3, `ask --attest`) | proof-closure | M | ✅ shipped |
| FrugalProof (`ask --frugalproof`) | defense | M | ✅ shipped |
| Sealed Approval · Drift Sentinel | defense | M | ✅ shipped (in the loop) |
| Sentinel CI (read-side) | ecosystem (B) | M | ✅ shipped · prober ⏳ |
| Keystone · Verdict · Threat Commons | ecosystem (B) | L | ⏳ deferred (new Solidity) |

**The through-line:** the right first move was never the flashiest earn scheme — it
was **closing the proof loop, waking the sleeping oracles, and turning frugality into
a provable make/buy economy.** That is what converts "auditable, not marketing" from
a slogan into a fact you can run `argus verify` against.
