# ARGUS-3 — Руководство пользователя (Русский)

> установка · настройка · ежедневное использование

---

## Что такое ARGUS

ARGUS-3 — ваш персональный AI-агент, единственный компонент AICOM для прямого общения с человеком. Работает на вашей машине с вашими API-ключами. WARDEN проверяет каждый MCP-инструмент перед запуском. Остальная экосистема (Factory, Hub, Oracles) автономна; вы общаетесь с ARGUS.

```bash
curl -fsSL https://magic-ai-factory.com/install | bash
```

## Установка

Запустите однострочный установщик. Проверит Node.js 20+, установит `@alexar76/argus3` глобально, создаст `~/.argus/agent` и запустит `argus setup`. Мастер: криптокошелёк (опционально, по умолчанию ВЫКЛ), режим среды, LLM-провайдер, Telegram, HTTP-токен.

## Ежедневное использование

`argus doctor` — проверка. `argus ask "задача"` — разовый запрос. `argus chat` — интерактивный REPL. `argus serve` — HTTP + Telegram + Arena. Ключи в `~/.argus/agent/.env`, конфиг в `argus.config.json`.

## Как общаться с ARGUS

Формулируйте чёткие задачи с финишем, не абстрактные «vibes». ARGUS отвечает на вашем языке. У каждой задачи жёсткий бюджет (токены + USD) — завершит и остановится. Чувствительные инструменты требуют явного подтверждения в CLI/Telegram.

## Устранение неполадок

Сначала `argus doctor`. Нет LLM? Добавьте `DEEPSEEK_API_KEY` или запустите Ollama. `command not found`? Добавьте `$(npm prefix -g)/bin` в PATH. MCP заблокирован? `argus warden scan`. Бюджет исчерпан? Сузьте задачу или поднимите лимиты.

---

## 😈 Когда ARGUS не поможет

Три честные причины, по которым агент скажет «нет».

🎬 [Смотреть анимированный мульт →](./humor/cartoon.html?lang=ru) · **[Читать полный roast →](./humor/ru.md)**

---

- [Ecosystem whitepaper (EN)](https://github.com/alexar76/aicom/blob/main/docs/ecosystem/whitepaper/en.md)
- [GitHub Issues](https://github.com/alexar76/argus/issues)
- [Landing](https://magic-ai-factory.com/argus/)
