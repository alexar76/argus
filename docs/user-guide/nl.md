# ARGUS-3 — Gebruikershandleiding (Nederlands)

> installatie · setup · dagelijks gebruik

---

## Wat is ARGUS

ARGUS-3 is je persoonlijke AI-agent — het enige AICOM-onderdeel voor direct menselijk gesprek. Draait op jouw machine met jouw API-sleutels. WARDEN controleert elke MCP-tool vóór uitvoering. De rest van het ecosysteem (Factory, Hub, Oracles) werkt autonoom; jij praat met ARGUS.

```bash
curl -fsSL https://magic-ai-factory.com/install | bash
```

## Installatie

Voer de one-liner installer uit. Controleert Node.js 20+, installeert `@alexar76/argus3` globaal, maakt `~/.argus/agent` aan en start `argus setup`. Wizard: crypto-wallet (optioneel, standaard UIT), omgevingsmodus, LLM-provider, optionele Telegram, HTTP-token.

## Dagelijks gebruik

`argus doctor` — gezondheidscheck. `argus ask "taak"` — eenmalig. `argus chat` — interactieve REPL. `argus serve` — HTTP + Telegram + Arena. Sleutels in `~/.argus/agent/.env`; config in `argus.config.json`.

## Hoe met ARGUS praten

Schrijf duidelijke taken met een eindpunt, geen vage vibes. ARGUS antwoordt in jouw taal. Elke taak heeft een hard budget (tokens + USD) — klaar en stopt. Gevoelige tools vereisen expliciete goedkeuring op CLI/Telegram.

## Probleemoplossing

Run eerst `argus doctor`. Geen LLM? Voeg `DEEPSEEK_API_KEY` toe of start Ollama. command not found? Voeg `$(npm prefix -g)/bin` toe aan PATH. MCP geblokkeerd? Check `argus warden scan`. Budget overschreden? Verklein de taak of verhoog limieten.

---

## 😈 Wanneer ARGUS je niet helpt

Drie eerlijke redenen waarom je agent nee zegt.

🎬 [Bekijk de animatie →](./humor/cartoon.html?lang=nl) · **[Lees de volledige roast →](./humor/nl.md)**

---

- [Ecosystem whitepaper (EN)](https://github.com/alexar76/aicom/blob/main/docs/ecosystem/whitepaper/en.md)
- [GitHub Issues](https://github.com/alexar76/argus/issues)
- [Landing](https://magic-ai-factory.com/argus/)
