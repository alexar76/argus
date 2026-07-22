# ARGUS — Riesgos residuales de seguridad y mitigación

> 🌐 Idiomas: [English](./security-residual-risks.md) · [Русский](./security-residual-risks-ru.md) · **Español**

> Última actualización: 2026-06-26 · ARGUS v0.2.0

Este documento enumera los riesgos residuales de seguridad de ARGUS — aquellos que no pueden eliminarse
arquitectónicamente pero pueden controlarse mediante configuración y prácticas operativas.
Cada riesgo se describe con sus mecanismos de protección y comandos concretos para verificación.

---

## R1: Clave privada de cartera en memoria del proceso

**Riesgo:** Mientras ARGUS corre con la economía habilitada, la clave privada de la cartera reside
en RAM. Un volcado de memoria (core dump, debugger, /proc/pid/mem) puede exponer la clave.

**Protecciones integradas:**
- La clave se almacena en disco SOLO en forma cifrada (keystore v2: ML-KEM-768 + ML-DSA-65 + AES-256-GCM)
- La clave NUNCA se registra, se pasa al modelo ni se muestra en la interfaz
- Keystore tiene permisos mode 600 (solo lectura/escritura del propietario)
- **Idle-lock (R2):** purga automática de la clave de memoria vía `ARGUS_WALLET_IDLE_LOCK_SEC`

**Cómo habilitar idle-lock:**
```bash
# Purge key from memory after 15 minutes of inactivity
export ARGUS_WALLET_IDLE_LOCK_SEC=900
argus serve
```

**Comprobar estado:**
```bash
# Shows key storage status: vault/vault-locked/plaintext-env/none
argus keystore address
```

**Medidas adicionales (operador):**
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

## R2: Los endpoints RPC ven tu IP y transacciones

**Riesgo:** En modo `live` (Base mainnet), ARGUS envía solicitudes RPC a nodos Base
públicos. Esos nodos ven tu dirección IP, la lista de contratos consultados y el
contenido de transacciones firmadas.

**Protecciones integradas:**
- **Fallback transport:** 5 public RPCs; cada solicitud puede enrutarse por un nodo distinto
- **ARGUS_RPC_PROXY:** soporte de proxy SOCKS5 y HTTP CONNECT
- **ARGUS_RPC_EXTRA_HEADERS:** custom HTTP headers para RPCs privados
- **Crypto OFF por defecto:** sin `AIFACTORY_CRYPTO_ENABLED=1`, no se envían solicitudes RPC

**Cómo enrutar tráfico RPC por TOR:**
```bash
# SOCKS5 via Tor (requires a running tor daemon):
export ARGUS_RPC_PROXY=socks5h://127.0.0.1:9050
argus serve
```

**Cómo enrutar por un RPC privado (Alchemy/Infura/QuickNode):**
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

**Verificación:**
```bash
# Shows current chain context and RPCs in use
argus doctor
```

---

## R3: Token del bot Telegram en una variable de entorno

**Riesgo:** Por defecto el token de Telegram se lee de `ARGUS_TELEGRAM_TOKEN` — una
variable de entorno que puede aparecer en build logs, docker inspect o ser visible
para otros procesos del mismo usuario.

**Protecciones integradas:**
- **Encrypted storage:** `argus telegram token-set` cifra el token vía scrypt + AES-256-GCM
- El archivo de token tiene permisos mode 600
- Prioridad de resolución: encrypted file → env var → disabled
- Validación de formato del token antes del cifrado (`<id>:<hash>`)

**Cómo cifrar el token:**
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

**Comprobar estado:**
```bash
argus telegram token-status
# Output:
#   encrypted file: /home/user/.argus/telegram-token.enc
#   token is stored encrypted on disk — ARGUS_KEYSTORE_PASSPHRASE unlocks it
```

---

## R4: Límite de confianza con el SDK @aimarket/agent

**Riesgo:** Con la economía habilitada, la clave privada se pasa al SDK `@aimarket/agent`
para firmar EIP-712 DebitAuthorization al abrir un channel e invocar paid
capabilities.

**Protecciones integradas:**
- **Hub URL enforcement:** solo HTTPS (o localhost para dev)
- **Content-Type validation:** todas las respuestas del Hub se comprueban como JSON
- **Response size limits:** search — 256KB, errors — 2KB
- **VerifyTee:** verificación de TEE attestation habilitada por defecto
- El SDK es un componente first-party AICOM, construido desde el mismo repositorio

**Cómo verificar la integridad del SDK:**
```bash
# Compare hash of installed package with reference
npm ls @aimarket/agent --json | jq -r '.dependencies["@aimarket/agent"].resolved'
sha256sum node_modules/@aimarket/agent/dist/index.js
```

**Cómo verificar que se usa el Hub correcto:**
```bash
# ARGUS_HUB_URL must be HTTPS
grep hubUrl argus.config.json
# → "hubUrl": "https://magic-ai-factory.com"

# On startup it is checked:
# - hubUrl must be HTTPS (AimarketConsumer constructor)
# - oracleFamilyUrl must be HTTPS (resolveOracleInvokeBase)
```

---

## R5: Servidores MCP de terceros

**Riesgo:** Los servidores MCP conectados corren como child processes y pueden leer el filesystem,
la red o intentar explotar el modelo mediante malicious tool definitions.

**Protecciones integradas:**
- **WARDEN firewall:** static scan → threat feed → reputation → pinning → drift detection
- **Allow-list env vars:** los child MCP processes reciben solo un subconjunto seguro (PATH, HOME, ...)
- **Las API keys NO se pasan** — ARGUS_*, ANTHROPIC_API_KEY, wallet key están aislados
- **Sensitive tool patterns:** `*delete*`, `*exec*`, `*write*`, `*spend*` requieren aprobación explícita
- **Pinning:** los hashes de tool-def se guardan; el drift se detecta en la siguiente conexión

**Cómo comprobar la seguridad del servidor MCP:**
```bash
# Scan server through WARDEN (without connecting):
argus warden scan --command "npx" --args "-y" "some-mcp-server"

# Show all connected servers and their verdicts:
argus warden status
```

---

## R6: Privacidad de episodios (historial de tareas)

**Riesgo:** El historial de tareas (preguntas, respuestas, tool calls) se almacena en `~/.argus/memory/`
en plaintext (JSON). Esto es necesario para self-learning (lesson distillation), pero
significa que cualquiera con acceso al directorio puede leer el historial.

**Protecciones integradas:**
- El directorio de estado `~/.argus/` tiene mode 700 (acceso completo del propietario)
- Los archivos de episodio dentro tienen mode 600
- No se envía telemetría a servidores AICOM

**Cómo minimizar:**
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

## R7: Los proveedores LLM de terceros ven el contenido de las tareas

**Riesgo:** Al usar cloud providers (Anthropic, DeepSeek, OpenAI), el contenido de
cada solicitud y respuesta se envía a sus servidores.

**Protecciones integradas:**
- **Local model por defecto para triage:** `local/llama3.1`
- **Ollama/vLLM:** modo totalmente local — ningún dato sale de la máquina
- **Budget governor:** limita el máximo de tokens y steps
- **Compactor:** reduce la cantidad de contexto transmitido

**Cómo cambiar a modo totalmente local:**
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

## Comprobación rápida de seguridad

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

## Threat model (resumen)

| Amenaza | Vector | Protección |
|--------|--------|------------|
| Memory dump | `/proc/pid/mem`, core dump | keystore + idle-lock |
| RPC interception | Network sniffing | RPC proxy (Tor/VPN) |
| Telegram token leak | `.env` in git, docker inspect | Encrypted storage |
| SDK compromise | Malicious npm package | HTTPS enforcement + Content-Type |
| MCP tool poisoning | Malicious MCP server | WARDEN: static scan + threat feed + reputation + pinning |
| Third-party LLM | Cloud providers | Local mode (Ollama) |
| Physical disk access | Reading ~/.argus/ | Mode 600/700 + keystore encryption |
| npm supply chain | Malicious dependency | Minimal dependencies (4 runtime) |
