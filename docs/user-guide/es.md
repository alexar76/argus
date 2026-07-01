# ARGUS-3 — Guía de usuario (Español)

> instalación · configuración · uso diario

---

## Qué es ARGUS

ARGUS-3 es tu agente de IA personal — el único componente de AICOM pensado para conversación directa con humanos. Corre en tu máquina con tus claves API. WARDEN revisa cada herramienta MCP antes de ejecutarla. El resto del ecosistema (Factory, Hub, Oracles) opera de forma autónoma; tú hablas con ARGUS.

```bash
curl -fsSL https://magic-ai-factory.com/install | bash
```

## Instalación

Ejecuta el instalador de una línea. Comprueba Node.js 20+, instala `@alexar76/argus3` globalmente, crea `~/.argus/agent` y lanza `argus setup`. El asistente cubre: wallet cripto (opcional, OFF por defecto), modo de entorno, proveedor LLM, Telegram opcional, token HTTP opcional.

## Uso diario

`argus doctor` — chequeo de salud. `argus ask "tarea"` — una sola vez. `argus chat` — REPL interactivo. `argus serve` — HTTP + Telegram + Arena. Claves en `~/.argus/agent/.env`; config en `argus.config.json`.

## Cómo hablar con ARGUS

Escribe tareas claras con meta, no vibes vagas. ARGUS responde en el idioma que uses. Cada tarea tiene presupuesto fijo (tokens + USD) — termina y para. Herramientas sensibles requieren aprobación explícita en CLI/Telegram.

## Solución de problemas

Ejecuta `argus doctor` primero. ¿Sin LLM? Añade `DEEPSEEK_API_KEY` o inicia Ollama. ¿Comando no encontrado? Añade `$(npm prefix -g)/bin` al PATH. ¿MCP bloqueado? Revisa `argus warden scan`. ¿Presupuesto excedido? Reduce la tarea o sube límites en config.

---

## 😈 Cuando ARGUS no te ayudará

Tres razones honestas por las que tu agente dice no.

🎬 [Ver el cartoon animado →](./humor/cartoon.html?lang=es) · **[Leer el roast completo →](./humor/es.md)**

---

- [Ecosystem whitepaper (EN)](https://github.com/alexar76/aicom/blob/main/docs/ecosystem/whitepaper/en.md)
- [GitHub Issues](https://github.com/alexar76/argus/issues)
- [Landing](https://magic-ai-factory.com/argus/)
