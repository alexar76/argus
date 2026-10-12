# ARGUS-3 — Guida utente (Italiano)

> installazione · configurazione · uso quotidiano

---

## Cos'è ARGUS

ARGUS-3 è il tuo agente IA personale — l'unico componente AICOM per conversazione diretta con gli umani. Gira sulla tua macchina con le tue chiavi API. WARDEN verifica ogni tool MCP prima dell'esecuzione. Il resto dell'ecosistema (Factory, Hub, Oracles) è autonomo; parli con ARGUS.

```bash
curl -fsSL https://magic-ai-factory.com/install | bash
```

## Installazione

Esegui l'installer monoriga. Verifica Node.js 20+, installa `@aimarket/argus` globalmente, crea `~/.argus/agent` e avvia `argus setup`. Wizard: wallet crypto (opzionale, OFF di default), modalità ambiente, provider LLM, Telegram opzionale, token HTTP opzionale.

## Uso quotidiano

`argus doctor` — controllo salute. `argus ask "compito"` — una tantum. `argus chat` — REPL interattivo. `argus serve` — HTTP + Telegram + Arena. Chiavi in `~/.argus/agent/.env`; config in `argus.config.json`.

## Come parlare con ARGUS

Scrivi compiti chiari con un traguardo, non vibes vaghe. ARGUS risponde nella tua lingua. Ogni compito ha budget fisso (token + USD) — finisce e si ferma. Tool sensibili richiedono approvazione esplicita su CLI/Telegram.

## Risoluzione problemi

Esegui prima `argus doctor`. Nessun LLM? Aggiungi `DEEPSEEK_API_KEY` o avvia Ollama. Comando non trovato? Aggiungi `$(npm prefix -g)/bin` al PATH. MCP bloccato? Controlla `argus warden scan`. Budget superato? Riduci il compito o alza i limiti.

---

## 😈 Quando ARGUS non ti aiuterà

Tre ragioni oneste per cui l'agente dice no.

🎬 [Guarda il cartoon animato →](./humor/cartoon.html?lang=it) · **[Leggi il roast completo →](./humor/it.md)**

---

- [Ecosystem whitepaper (EN)](https://github.com/alexar76/aicom/blob/main/docs/ecosystem/whitepaper/en.md)
- [GitHub Issues](https://github.com/alexar76/argus/issues)
- [Landing](https://magic-ai-factory.com/argus/)
