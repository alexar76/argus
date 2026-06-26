export function printHelp(): void {
  console.log(`ARGUS — wallet-native, security-hardened personal agent

Usage:
  argus setup                        interactive setup (wallet seed → provider/keys) — start here
  argus keystore create              create an encrypted wallet vault (new seed or --import)
  argus keystore address             print the vaulted wallet's public address
  argus ask "<task>"                 one-shot task
  argus chat                         interactive session
  argus doctor                       show config, providers, economy status
  argus serve                        run channels (HTTP /health + Telegram) — for Docker/servers
  argus telegram                     run only the owner-locked Telegram bot
  argus mcp                          expose ARGUS as an MCP server (stdio) for other agents/IDEs
  argus flex                         show your 🎮 Agent Arena card (web UI at /arena via serve)
  argus warden scan                  WARDEN-vet configured MCP servers
  argus verify <bundle.json>         offline-re-verify a proof bundle (no network/wallet)
  argus oracle <verb>                verifiable math in one word — Oracle Studio (try: oracle list)
  argus passport                     your portable, verifiable reputation card
  argus broker "<intent>"            make/buy advice — think locally vs buy a capability
  argus economy status               economy on/off + wallet
  argus economy discover "<intent>"  find paid capabilities (needs wallet)
  argus economy register             register this agent in the AI Service Mesh

Flags:
  --config <path>   use a specific config file
  --budget <usd>    budget for economy discovery
  --provenance <f>  (with ask) write the answer's verifiable proof bundle to a file
  --attest <f>      (with ask) write a signed negative attestation of the session
  --frugalproof <f> (with ask) write a verifiable cost receipt (oracle-anchored if reachable)
  --conscience <f>  (with ask) write the FULL verifiable conscience — receipts + cost + consent chain + attestation in one bundle (re-check: argus verify)
  --yes             auto-approve sensitive tools (use with care)
  --verbose         debug logging

ARGUS runs fully autonomously with no wallet. Set ARGUS_WALLET_KEY to connect to
the AICOM economy. See docs/ for architecture, security, and economy details.`);
}
