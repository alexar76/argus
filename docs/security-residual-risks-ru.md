# ARGUS — Остаточные риски безопасности и митигация

> 🌐 Язык: [English](./security-residual-risks.md) · **Русский** · [Español](./security-residual-risks-es.md)

> Последнее обновление: 2026-06-26 · ARGUS v0.2.0

Этот документ перечисляет остаточные риски безопасности ARGUS — те, которые нельзя устранить
архитектурно, но можно контролировать через конфигурацию и операционные практики.
Каждый риск описан с защитными механизмами и конкретными командами для проверки.

---

## R1: Приватный ключ кошелька в памяти процесса

**Риск:** Пока ARGUS работает с включённой экономикой, приватный ключ кошелька находится
в RAM. Memory dump (core dump, debugger, /proc/pid/mem) может раскрыть ключ.

**Встроенные защиты:**
- Ключ на диске хранится ТОЛЬКО в зашифрованном виде (keystore v2: ML-KEM-768 + ML-DSA-65 + AES-256-GCM)
- Ключ НИКОГДА не логируется, не передаётся модели и не отображается в интерфейсе
- Keystore имеет права mode 600 (только чтение/запись владельца)
- **Idle-lock (R2):** автоматическая очистка ключа из памяти через `ARGUS_WALLET_IDLE_LOCK_SEC`

**Как включить idle-lock:**
```bash
# Purge key from memory after 15 minutes of inactivity
export ARGUS_WALLET_IDLE_LOCK_SEC=900
argus serve
```

**Проверка статуса:**
```bash
# Shows key storage status: vault/vault-locked/plaintext-env/none
argus keystore address
```

**Дополнительные меры (оператор):**
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

## R2: RPC endpoints видят ваш IP и транзакции

**Риск:** В режиме `live` (Base mainnet) ARGUS отправляет RPC-запросы на публичные Base
nodes. Эти узлы видят ваш IP, список запрашиваемых контрактов и содержимое подписанных
транзакций.

**Встроенные защиты:**
- **Fallback transport:** 5 public RPCs; каждый запрос может идти через другой узел
- **ARGUS_RPC_PROXY:** поддержка SOCKS5 и HTTP CONNECT proxy
- **ARGUS_RPC_EXTRA_HEADERS:** custom HTTP headers для private RPCs
- **Crypto OFF по умолчанию:** без `AIFACTORY_CRYPTO_ENABLED=1` RPC-запросы не отправляются

**Как маршрутизировать RPC через TOR:**
```bash
# SOCKS5 via Tor (requires a running tor daemon):
export ARGUS_RPC_PROXY=socks5h://127.0.0.1:9050
argus serve
```

**Как маршрутизировать через private RPC (Alchemy/Infura/QuickNode):**
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

**Проверка:**
```bash
# Shows current chain context and RPCs in use
argus doctor
```

---

## R3: Telegram bot token в переменной окружения

**Риск:** По умолчанию Telegram token читается из `ARGUS_TELEGRAM_TOKEN` —
environment variable, которая может появиться в build logs, docker inspect или быть
видна другим процессам того же пользователя.

**Встроенные защиты:**
- **Encrypted storage:** `argus telegram token-set` шифрует token через scrypt + AES-256-GCM
- Token file имеет права mode 600
- Приоритет разрешения: encrypted file → env var → disabled
- Валидация формата token перед шифрованием (`<id>:<hash>`)

**Как зашифровать token:**
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

**Проверка статуса:**
```bash
argus telegram token-status
# Output:
#   encrypted file: /home/user/.argus/telegram-token.enc
#   token is stored encrypted on disk — ARGUS_KEYSTORE_PASSPHRASE unlocks it
```

---

## R4: Trust boundary с SDK @aimarket/agent

**Риск:** При включённой экономике приватный ключ передаётся в SDK `@aimarket/agent`
для подписи EIP-712 DebitAuthorization при открытии channel и invoke paid
capabilities.

**Встроенные защиты:**
- **Hub URL enforcement:** только HTTPS (или localhost для dev)
- **Content-Type validation:** все ответы Hub проверяются на JSON
- **Response size limits:** search — 256KB, errors — 2KB
- **VerifyTee:** проверка TEE attestation включена по умолчанию
- SDK — first-party AICOM component, собран из того же репозитория

**Как проверить целостность SDK:**
```bash
# Compare hash of installed package with reference
npm ls @aimarket/agent --json | jq -r '.dependencies["@aimarket/agent"].resolved'
sha256sum node_modules/@aimarket/agent/dist/index.js
```

**Как проверить, что используется правильный Hub:**
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

**Риск:** Подключённые MCP servers работают как child processes и могут читать filesystem,
network или пытаться эксплуатировать модель через malicious tool definitions.

**Встроенные защиты:**
- **WARDEN firewall:** static scan → threat feed → reputation → pinning → drift detection
- **Allow-list env vars:** child MCP processes получают только безопасное подмножество (PATH, HOME, ...)
- **API keys НЕ передаются** — ARGUS_*, ANTHROPIC_API_KEY, wallet key изолированы
- **Sensitive tool patterns:** `*delete*`, `*exec*`, `*write*`, `*spend*` требуют явного approval
- **Pinning:** tool-def hashes сохраняются; drift обнаруживается при следующем подключении

**Как проверить безопасность MCP server:**
```bash
# Scan server through WARDEN (without connecting):
argus warden scan --command "npx" --args "-y" "some-mcp-server"

# Show all connected servers and their verdicts:
argus warden status
```

---

## R6: Episode privacy (история задач)

**Риск:** История задач (вопросы, ответы, tool calls) хранится в `~/.argus/memory/`
в plaintext (JSON). Это нужно для self-learning (lesson distillation), но
означает, что любой с доступом к каталогу может прочитать историю.

**Встроенные защиты:**
- State directory `~/.argus/` имеет mode 700 (полный доступ владельца)
- Episode files внутри имеют mode 600
- Телеметрия на серверы AICOM не отправляется

**Как минимизировать:**
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

## R7: Third-party LLM providers видят содержимое задач

**Риск:** При использовании cloud providers (Anthropic, DeepSeek, OpenAI) содержимое
каждого запроса и ответа отправляется на их серверы.

**Встроенные защиты:**
- **Local model по умолчанию для triage:** `local/llama3.1`
- **Ollama/vLLM:** полностью локальный режим — данные не покидают машину
- **Budget governor:** ограничивает максимум tokens и steps
- **Compactor:** уменьшает объём передаваемого контекста

**Как переключиться на полностью локальный режим:**
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

## Быстрая проверка безопасности

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

| Угроза | Вектор | Защита |
|--------|--------|------------|
| Memory dump | `/proc/pid/mem`, core dump | keystore + idle-lock |
| RPC interception | Network sniffing | RPC proxy (Tor/VPN) |
| Telegram token leak | `.env` in git, docker inspect | Encrypted storage |
| SDK compromise | Malicious npm package | HTTPS enforcement + Content-Type |
| MCP tool poisoning | Malicious MCP server | WARDEN: static scan + threat feed + reputation + pinning |
| Third-party LLM | Cloud providers | Local mode (Ollama) |
| Physical disk access | Reading ~/.argus/ | Mode 600/700 + keystore encryption |
| npm supply chain | Malicious dependency | Minimal dependencies (4 runtime) |
