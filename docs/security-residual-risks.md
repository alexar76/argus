# ARGUS — Residual Security Risks and Mitigation

> 🌐 Language: **English** · [Русский](./security-residual-risks-ru.md) · [Español](./security-residual-risks-es.md)

> Last updated: 2026-06-26 · ARGUS v0.2.0

This document lists ARGUS residual security risks — those that cannot be eliminated
architecturally but can be controlled through configuration and operational practices.
Each risk is described with its protective mechanisms and concrete commands for verification.

---

## R1: Wallet private key in process memory

**Risk:** While ARGUS runs with the economy enabled, the wallet private key resides
in RAM. A memory dump (core dump, debugger, /proc/pid/mem) can expose the key.

**Built-in protections:**
- The key is stored on disk ONLY in encrypted form (keystore v2: ML-KEM-768 + ML-DSA-65 + AES-256-GCM)
- The key is NEVER logged, passed to the model, or displayed in the interface
- Keystore has mode 600 permissions (owner read/write only)
- **Idle-lock (R2):** automatic key purge from memory via `ARGUS_WALLET_IDLE_LOCK_SEC`

**How to enable idle-lock:**
```bash
# Purge key from memory after 15 minutes of inactivity
export ARGUS_WALLET_IDLE_LOCK_SEC=900
argus serve
```

**Status check:**
```bash
# Shows key storage status: vault/vault-locked/plaintext-env/none
argus keystore address
```

**Additional measures (operator):**
```bash
# Disable core dumps for the process
ulimit -c 0

# Run with restricted /proc access (Linux)
# In docker: add to docker-compose:
#   security_opt:
#     - no-new-privileges:true
#   cap_drop:
#     - ALL
```

---

## R2: RPC endpoints see your IP and transactions

**Risk:** In `live` mode (Base mainnet), ARGUS sends RPC requests to public Base
nodes. Those nodes see your IP address, the list of contracts queried, and the
contents of signed transactions.

**Built-in protections:**
- **Fallback transport:** 5 public RPCs; each request may route through a different node
- **ARGUS_RPC_PROXY:** SOCKS5 and HTTP CONNECT proxy support
- **ARGUS_RPC_EXTRA_HEADERS:** custom HTTP headers for private RPCs
- **Crypto OFF by default:** without `AIFACTORY_CRYPTO_ENABLED=1`, no RPC requests are sent

**How to route RPC traffic through TOR:**
```bash
# SOCKS5 via Tor (requires a running tor daemon):
export ARGUS_RPC_PROXY=socks5h://127.0.0.1:9050
argus serve
```

**How to route through a private RPC (Alchemy/Infura/QuickNode):**
```bash
# 1. Override the RPC list
export ARGUS_RPC_BASE=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY

# 2. Add API key in headers
export ARGUS_RPC_EXTRA_HEADERS='{"Authorization":"Bearer YOUR_JWT"}'

# 3. Or use both
export ARGUS_RPC_BASE=https://your-private-node.example.com
export ARGUS_RPC_EXTRA_HEADERS='{"X-API-Key":"sk_live_..."}'
argus serve
```

**Verification:**
```bash
# Shows current chain context and RPCs in use
argus doctor
```

---

## R3: Telegram bot token in an environment variable

**Risk:** By default the Telegram token is read from `ARGUS_TELEGRAM_TOKEN` — an
environment variable that may appear in build logs, docker inspect, or be visible
to other processes of the same user.

**Built-in protections:**
- **Encrypted storage:** `argus telegram token-set` encrypts the token via scrypt + AES-256-GCM
- Token file has mode 600 permissions
- Resolution priority: encrypted file → env var → disabled
- Token format validation before encryption (`<id>:<hash>`)

**How to encrypt the token:**
```bash
# Interactive (will prompt for token):
export ARGUS_KEYSTORE_PASSPHRASE="your-strong-passphrase"
argus telegram token-set

# Non-interactive (CI/CD):
export ARGUS_KEYSTORE_PASSPHRASE="..."
export ARGUS_TELEGRAM_TOKEN="12345:ABCdef..."
argus telegram token-set
# After this you can remove ARGUS_TELEGRAM_TOKEN from .env
```

**Status check:**
```bash
argus telegram token-status
# Output:
#   encrypted file: /home/user/.argus/telegram-token.enc
#   token is stored encrypted on disk — ARGUS_KEYSTORE_PASSPHRASE unlocks it
```

---

## R4: Trust boundary with @aimarket/agent SDK

**Risk:** With the economy enabled, the private key is passed to the `@aimarket/agent`
SDK to sign EIP-712 DebitAuthorization when opening a channel and invoking paid
capabilities.

**Built-in protections:**
- **Hub URL enforcement:** HTTPS only (or localhost for dev)
- **Content-Type validation:** all Hub responses are checked for JSON
- **Response size limits:** search — 256KB, errors — 2KB
- **VerifyTee:** TEE attestation verification enabled by default
- SDK is a first-party AICOM component, built from the same repository

**How to verify SDK integrity:**
```bash
# Compare hash of installed package with reference
npm ls @aimarket/agent --json | jq -r '.dependencies["@aimarket/agent"].resolved'
sha256sum node_modules/@aimarket/agent/dist/index.js
```

**How to verify the correct Hub is used:**
```bash
# ARGUS_HUB_URL must be HTTPS
grep hubUrl argus.config.json
# → "hubUrl": "https://magic-ai-factory.com"

# On startup it is checked:
# - hubUrl must be HTTPS (AimarketConsumer constructor)
# - oracleFamilyUrl must be HTTPS (resolveOracleInvokeBase)
```

---

## R5: Third-party MCP servers

**Risk:** Connected MCP servers run as child processes and may read the filesystem,
network, or attempt to exploit the model through malicious tool definitions.

**Built-in protections:**
- **WARDEN firewall:** static scan → threat feed → reputation → pinning → drift detection
- **Allow-list env vars:** child MCP processes receive only a safe subset (PATH, HOME, ...)
- **API keys are NOT passed** — ARGUS_*, ANTHROPIC_API_KEY, wallet key are isolated
- **Sensitive tool patterns:** `*delete*`, `*exec*`, `*write*`, `*spend*` require explicit approval
- **Pinning:** tool-def hashes are saved; drift is detected on next connection

**How to check MCP server security:**
```bash
# Scan server through WARDEN (without connecting):
argus warden scan --command "npx" --args "-y" "some-mcp-server"

# Show all connected servers and their verdicts:
argus warden status
```

---

## R6: Episode privacy (task history)

**Risk:** Task history (questions, answers, tool calls) is stored in `~/.argus/memory/`
in plaintext (JSON). This is required for self-learning (lesson distillation), but
means anyone with directory access can read the history.

**Built-in protections:**
- State directory `~/.argus/` has mode 700 (owner full access)
- Episode files inside have mode 600
- No telemetry is sent to AICOM servers

**How to minimize:**
```bash
# Limit history (in argus.config.json):
{
  "memory": {
    "maxEpisodes": 100
  }
}

# Periodically clear old episodes:
rm ~/.argus/memory/episodes.json

# Use tmpfs for state directory (cleared on reboot):
export ARGUS_HOME=/run/argus-state
mount -t tmpfs tmpfs /run/argus-state
```

---

## R7: Third-party LLM providers see task content

**Risk:** When using cloud providers (Anthropic, DeepSeek, OpenAI), the content of
each request and response is sent to their servers.

**Built-in protections:**
- **Local model by default for triage:** `local/llama3.1`
- **Ollama/vLLM:** fully local mode — no data leaves the machine
- **Budget governor:** limits maximum tokens and steps
- **Compactor:** reduces amount of context transmitted

**How to switch to fully local mode:**
```bash
# 1. Install Ollama
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3.1
ollama pull qwen2.5:7b

# 2. Configure argus.config.json:
{
  "models": {
    "triage": { "ref": "local/llama3.1" },
    "core":   { "ref": "local/qwen2.5:7b" },
    "heavy":  { "ref": "local/llama3.1" }
  }
}

# 3. Ensure API keys are NOT set:
unset ANTHROPIC_API_KEY
unset DEEPSEEK_API_KEY
unset OPENAI_API_KEY

# 4. Start
argus serve
```

---

## Quick security check

```bash
# Full configuration audit:
argus doctor

# Check keystore status:
argus keystore address

# Check Telegram token status:
argus telegram token-status

# Check wallet status:
argus economy status

# Check WARDEN (MCP firewall):
argus warden status

# Verify consent log integrity (hash chain):
argus verify ~/.argus/verify-bundles/latest.json
```

---

## Threat model (summary)

| Threat | Vector | Protection |
|--------|--------|------------|
| Memory dump | `/proc/pid/mem`, core dump | keystore + idle-lock |
| RPC interception | Network sniffing | RPC proxy (Tor/VPN) |
| Telegram token leak | `.env` in git, docker inspect | Encrypted storage |
| SDK compromise | Malicious npm package | HTTPS enforcement + Content-Type |
| MCP tool poisoning | Malicious MCP server | WARDEN: static scan + threat feed + reputation + pinning |
| Third-party LLM | Cloud providers | Local mode (Ollama) |
| Physical disk access | Reading ~/.argus/ | Mode 600/700 + keystore encryption |
| npm supply chain | Malicious dependency | Minimal dependencies (4 runtime) |
