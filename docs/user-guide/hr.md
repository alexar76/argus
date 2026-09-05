# ARGUS-3 — Korisnički vodič (Hrvatski)

> instalacija · postavljanje · svakodnevna upotreba

---

## Što je ARGUS

ARGUS-3 je vaš osobni AI agent — jedina AICOM komponenta za izravni razgovor s čovjekom. Radi na vašem računalu s vašim API ključevima. WARDEN provjerava svaki MCP alat prije pokretanja. Ostatak ekosustava (Factory, Hub, Oracles) radi autonomno; vi razgovarate s ARGUS-om.

```bash
curl -fsSL https://magic-ai-factory.com/install | bash
```

## Instalacija

Pokrenite jednolinijski instalator. Provjerava Node.js 20+, globalno instalira `@aimarket/argus`, stvara `~/.argus/agent` i pokreće `argus setup`. Čarobnjak: kripto novčanik (opcionalno, default OFF), okruženje, LLM provider, Telegram, HTTP token.

## Svakodnevna upotreba

`argus doctor` — provjera. `argus ask "zadatak"` — jednokratno. `argus chat` — interaktivni REPL. `argus serve` — HTTP + Telegram + Arena. Ključevi u `~/.argus/agent/.env`; config u `argus.config.json`.

## Kako razgovarati s ARGUS-om

Pišite jasne zadatke s ciljem, ne vague vibes. ARGUS odgovara na vašem jeziku. Svaki zadatak ima tvrdi budžet (tokeni + USD) — završi i stane. Osjetljivi alati traže eksplicitno odobrenje u CLI/Telegramu.

## Rješavanje problema

Prvo `argus doctor`. Nema LLM-a? Dodajte `DEEPSEEK_API_KEY` ili pokrenite Ollama. command not found? Dodajte `$(npm prefix -g)/bin` u PATH. MCP blokiran? `argus warden scan`. Budžet iscrpljen? Suzite zadatak ili podignite limite.

---

## 😈 Kad ARGUS neće pomoći

Tri iskrena razloga zašto agent kaže ne.

🎬 [Pogledaj animirani cartoon →](./humor/cartoon.html?lang=hr) · **[Pročitaj cijeli roast →](./humor/hr.md)**

---

- [Ecosystem whitepaper (EN)](https://github.com/alexar76/aicom/blob/main/docs/ecosystem/whitepaper/en.md)
- [GitHub Issues](https://github.com/alexar76/argus/issues)
- [Landing](https://magic-ai-factory.com/argus/)
