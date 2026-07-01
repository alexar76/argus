# ARGUS-3 — Používateľská príručka (Slovenčina)

> inštalácia · nastavenie · denné používanie

---

## Čo je ARGUS

ARGUS-3 je váš osobný AI agent — jediná súčasť AICOM na priamu konverzáciu s človekom. Beží na vašom počítači s vašimi API kľúčmi. WARDEN kontroluje každý MCP nástroj pred spustením. Zvyšok ekosystému (Factory, Hub, Oracles) je autonómny; vy komunikujete s ARGUS.

```bash
curl -fsSL https://magic-ai-factory.com/install | bash
```

## Inštalácia

Spustite jednoriadkový inštalátor. Skontroluje Node.js 20+, nainštaluje `@alexar76/argus3` globálne, vytvorí `~/.argus/agent` a spustí `argus setup`. Sprievodca: krypto peňaženka (voliteľné, predvolene VYP), režim prostredia, LLM poskytovateľ, Telegram, HTTP token.

## Denné používanie

`argus doctor` — kontrola. `argus ask "úloha"` — jednorazovo. `argus chat` — interaktívny REPL. `argus serve` — HTTP + Telegram + Arena. Kľúče v `~/.argus/agent/.env`; konfig v `argus.config.json`.

## Ako komunikovať s ARGUS

Píšte jasné úlohy s cieľom, nie vágne vibes. ARGUS odpovedá vo vašom jazyku. Každá úloha má tvrdý rozpočet (tokeny + USD) — dokončí a zastaví sa. Citlivé nástroje vyžadujú explicitné schválenie v CLI/Telegram.

## Riešenie problémov

Najprv `argus doctor`. Žiadny LLM? Pridajte `DEEPSEEK_API_KEY` alebo spustite Ollama. command not found? Pridajte `$(npm prefix -g)/bin` do PATH. MCP blokované? `argus warden scan`. Rozpočet vyčerpaný? Zúžte úlohu alebo zvýšte limity.

---

## 😈 Keď ARGUS nepomôže

Tri úprimné dôvody, prečo agent povie nie.

🎬 [Pozrieť animovaný cartoon →](./humor/cartoon.html?lang=sk) · **[Prečítajte celý roast →](./humor/sk.md)**

---

- [Ecosystem whitepaper (EN)](https://github.com/alexar76/aicom/blob/main/docs/ecosystem/whitepaper/en.md)
- [GitHub Issues](https://github.com/alexar76/argus/issues)
- [Landing](https://magic-ai-factory.com/argus/)
