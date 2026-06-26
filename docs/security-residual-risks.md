# ARGUS — Остаточные риски безопасности и их устранение

> Последнее обновление: 2026-06-26 · ARGUS v0.2.0

В этом документе перечислены остаточные риски безопасности ARGUS — те, которые
нельзя устранить архитектурно, но можно контролировать через конфигурацию и
операционные практики. Каждый риск описан с указанием механизмов защиты и
конкретных команд для проверки.

---

## R1: Приватный ключ кошелька в памяти процесса

**Риск:** Пока ARGUS работает с включённой экономикой, приватный ключ кошелька
находится в оперативной памяти. Дамп памяти (core dump, отладчик, /proc/pid/mem)
может раскрыть ключ.

**Встроенные защиты:**
- Ключ хранится на диске ТОЛЬКО в зашифрованном виде (keystore v2: ML-KEM-768 + ML-DSA-65 + AES-256-GCM)
- Ключ НИКОГДА не логируется, не передаётся модели, не отображается в интерфейсе
- Keystore имеет права 600 (владелец — чтение/запись)
- **Idle-lock (R2):** автоматическая очистка ключа из памяти через `ARGUS_WALLET_IDLE_LOCK_SEC`

**Как включить idle-lock:**
```bash
# Очищать ключ из памяти после 15 минут бездействия
export ARGUS_WALLET_IDLE_LOCK_SEC=900
argus serve
```

**Проверка статуса:**
```bash
# Показывает статус хранения ключа: vault/vault-locked/plaintext-env/none
argus keystore address
```

**Дополнительные меры (оператор):**
```bash
# Запретить core dumps для процесса
ulimit -c 0

# Запускать с ограничением доступа к /proc (Linux)
# В docker: добавьте в docker-compose:
#   security_opt:
#     - no-new-privileges:true
#   cap_drop:
#     - ALL
```

---

## R2: RPC-эндпоинты видят ваш IP и транзакции

**Риск:** При работе в режиме `live` (Base mainnet) ARGUS отправляет RPC-запросы
к публичным нодам Base. Эти ноды видят ваш IP-адрес, список запрашиваемых
контрактов и содержимое подписанных транзакций.

**Встроенные защиты:**
- **Fallback-транспорт:** 5 публичных RPC, каждый запрос может пойти через разную ноду
- **ARGUS_RPC_PROXY:** поддержка SOCKS5 и HTTP CONNECT прокси
- **ARGUS_RPC_EXTRA_HEADERS:** кастомные HTTP-заголовки для приватных RPC
- **Crypto OFF by default:** без `AIFACTORY_CRYPTO_ENABLED=1` RPC-запросы не отправляются

**Как направить RPC-трафик через TOR:**
```bash
# SOCKS5 через Tor (нужен запущенный tor daemon):
export ARGUS_RPC_PROXY=socks5h://127.0.0.1:9050
argus serve
```

**Как направить через приватный RPC (Alchemy/Infura/QuickNode):**
```bash
# 1. Переопределить список RPC
export ARGUS_RPC_BASE=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY

# 2. Добавить API-ключ в заголовки
export ARGUS_RPC_EXTRA_HEADERS='{"Authorization":"Bearer YOUR_JWT"}'

# 3. Или использовать оба
export ARGUS_RPC_BASE=https://your-private-node.example.com
export ARGUS_RPC_EXTRA_HEADERS='{"X-API-Key":"sk_live_..."}'
argus serve
```

**Проверка:**
```bash
# Покажет текущий chain context и используемые RPC
argus doctor
```

---

## R3: Telegram bot токен в переменной окружения

**Риск:** По умолчанию Telegram токен читается из `ARGUS_TELEGRAM_TOKEN` —
переменной окружения, которая может попасть в логи сборки, docker inspect,
или быть видна другим процессам того же пользователя.

**Встроенные защиты:**
- **Зашифрованное хранение:** `argus telegram token-set` шифрует токен через scrypt + AES-256-GCM
- Токен-файл имеет права 600
- Приоритет разрешения: зашифрованный файл → env var → отключён
- Валидация формата токена перед шифрованием (`<id>:<hash>`)

**Как зашифровать токен:**
```bash
# Интерактивно (спросит токен):
export ARGUS_KEYSTORE_PASSPHRASE="ваш-надёжный-пароль"
argus telegram token-set

# Неинтерактивно (CI/CD):
export ARGUS_KEYSTORE_PASSPHRASE="..."
export ARGUS_TELEGRAM_TOKEN="12345:ABCdef..."
argus telegram token-set
# После этого можно удалить ARGUS_TELEGRAM_TOKEN из .env
```

**Проверка статуса:**
```bash
argus telegram token-status
# Вывод:
#   encrypted file: /home/user/.argus/telegram-token.enc
#   token is stored encrypted on disk — ARGUS_KEYSTORE_PASSPHRASE unlocks it
```

---

## R4: Граница доверия с @aimarket/agent SDK

**Риск:** При включённой экономике приватный ключ передаётся в `@aimarket/agent` SDK
для подписи EIP-712 DebitAuthorization при открытии канала и вызове платных
capabilities.

**Встроенные защиты:**
- **Hub URL enforcement:** только HTTPS (или localhost для dev)
- **Content-Type валидация:** все ответы Hub проверяются на JSON
- **Response size limits:** поиск — 256KB, ошибки — 2KB
- **VerifyTee:** по умолчанию включена проверка TEE-аттестации
- SDK — first-party компонент AICOM, собирается из того же репозитория

**Как проверить целостность SDK:**
```bash
# Сравнить хеш установленного пакета с эталонным
npm ls @aimarket/agent --json | jq -r '.dependencies["@aimarket/agent"].resolved'
sha256sum node_modules/@aimarket/agent/dist/index.js
```

**Как проверить что Hub используется правильный:**
```bash
# ARGUS_HUB_URL должен быть HTTPS
grep hubUrl argus.config.json
# → "hubUrl": "https://magic-ai-factory.com"

# При запуске проверяется:
# - hubUrl должен быть HTTPS (конструктор AimarketConsumer)
# - oracleFamilyUrl должен быть HTTPS (resolveOracleInvokeBase)
```

---

## R5: MCP-серверы третьих сторон

**Риск:** Подключённые MCP-серверы запускаются как дочерние процессы и потенциально
могут читать файловую систему, сеть, или пытаться эксплуатировать модель через
вредоносные tool definitions.

**Встроенные защиты:**
- **WARDEN firewall:** static scan → threat feed → reputation → pinning → drift detection
- **Allow-list env vars:** дочерним MCP-процессам передаётся только безопасное подмножество (PATH, HOME, ...)
- **API-ключи НЕ передаются** — ARGUS_*, ANTHROPIC_API_KEY, ключ кошелька изолированы
- **Sensitive tool patterns:** `*delete*`, `*exec*`, `*write*`, `*spend*` требуют явного approval
- **Pinning:** tool-def хеши сохраняются; дрифт детектится при следующем подключении

**Как проверить безопасность MCP-сервера:**
```bash
# Просканировать сервер через WARDEN (без подключения):
argus warden scan --command "npx" --args "-y" "some-mcp-server"

# Показать все подключённые серверы и их вердикты:
argus warden status
```

---

## R6: Конфиденциальность эпизодов (история задач)

**Риск:** История задач (вопросы, ответы, tool calls) хранится в `~/.argus/memory/`
в открытом виде (JSON). Это необходимо для self-learning (lesson distillation),
но означает что любой с доступом к директории может прочитать историю.

**Встроенные защиты:**
- State-директория `~/.argus/` имеет права 700 (владелец — полный доступ)
- Файлы эпизодов внутри — права 600
- Никакая телеметрия не отправляется на серверы AICOM

**Как минимизировать:**
```bash
# Ограничить историю (в argus.config.json):
{
  "memory": {
    "maxEpisodes": 100
  }
}

# Периодически очищать старые эпизоды:
rm ~/.argus/memory/episodes.json

# Использовать tmpfs для state-директории (стирается при перезагрузке):
export ARGUS_HOME=/run/argus-state
mount -t tmpfs tmpfs /run/argus-state
```

---

## R7: Сторонние LLM-провайдеры видят содержимое задач

**Риск:** При использовании облачных провайдеров (Anthropic, DeepSeek, OpenAI)
содержимое каждого запроса и ответа отправляется на их серверы.

**Встроенные защиты:**
- **Локальная модель по умолчанию для triage:** `local/llama3.1`
- **Ollama/vLLM:** полностью локальный режим — никакие данные не покидают машину
- **Budget governor:** ограничивает максимальное число токенов и шагов
- **Compactor:** снижает количество передаваемого контекста

**Как перейти на полностью локальный режим:**
```bash
# 1. Установить Ollama
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3.1
ollama pull qwen2.5:7b

# 2. Настроить argus.config.json:
{
  "models": {
    "triage": { "ref": "local/llama3.1" },
    "core":   { "ref": "local/qwen2.5:7b" },
    "heavy":  { "ref": "local/llama3.1" }
  }
}

# 3. Убедиться что API-ключи НЕ установлены:
unset ANTHROPIC_API_KEY
unset DEEPSEEK_API_KEY
unset OPENAI_API_KEY

# 4. Запустить
argus serve
```

---

## Быстрая проверка безопасности

```bash
# Полный аудит конфигурации:
argus doctor

# Проверить статус keystore:
argus keystore address

# Проверить статус Telegram токена:
argus telegram token-status

# Проверить статус кошелька:
argus economy status

# Проверить WARDEN (MCP firewall):
argus warden status

# Проверить целостность consent-лога (hash chain):
argus verify ~/.argus/verify-bundles/latest.json
```

---

## Модель угроз (кратко)

| Угроза | Вектор | Защита |
|--------|--------|--------|
| Дамп памяти | `/proc/pid/mem`, core dump | keystore + idle-lock |
| Перехват RPC | Сетевой сниффинг | RPC proxy (Tor/VPN) |
| Утечка Telegram токена | `.env` в git, docker inspect | Зашифрованное хранение |
| Компрометация SDK | Вредоносный npm пакет | HTTPS enforcement + Content-Type |
| MCP tool poisoning | Вредоносный MCP-сервер | WARDEN: static scan + threat feed + reputation + pinning |
| Сторонний LLM | Облачные провайдеры | Локальный режим (Ollama) |
| Физический доступ к диску | Чтение ~/.argus/ | Права 600/700 + шифрование keystore |
| Supply chain npm | Вредоносная зависимость | Минимальные зависимости (4 runtime) |
