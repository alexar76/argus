# ARGUS-3 — Benutzerhandbuch (Deutsch)

> Installation · Einrichtung · tägliche Nutzung

---

## Was ist ARGUS

ARGUS-3 ist dein persönlicher KI-Agent — die einzige AICOM-Komponente für direkte menschliche Konversation. Läuft auf deiner Maschine mit deinen API-Schlüsseln. WARDEN prüft jedes MCP-Tool vor der Ausführung. Der Rest des Ökosystems (Factory, Hub, Oracles) arbeitet autonom; du sprichst mit ARGUS.

```bash
curl -fsSL https://magic-ai-factory.com/install | bash
```

## Installation

Einzeiler-Installer ausführen. Prüft Node.js 20+, installiert `@aimarket/argus` global, erstellt `~/.argus/agent` und startet `argus setup`. Assistent: Krypto-Wallet (optional, standardmäßig AUS), Umgebungsmodus, LLM-Anbieter, optionales Telegram, optionaler HTTP-Token.

## Tägliche Nutzung

`argus doctor` — Gesundheitscheck. `argus ask "Aufgabe"` — Einmalaufgabe. `argus chat` — interaktives REPL. `argus serve` — HTTP + Telegram + Arena. Schlüssel in `~/.argus/agent/.env`; Config in `argus.config.json`.

## So sprichst du mit ARGUS

Formuliere klare Aufgaben mit Endpunkt, keine vagen Vibes. ARGUS antwortet in deiner Sprache. Jede Aufgabe hat ein hartes Budget (Tokens + USD) — erledigt und stoppt. Sensible Tools brauchen explizite Freigabe in CLI/Telegram.

## Fehlerbehebung

Zuerst `argus doctor`. Kein LLM? `DEEPSEEK_API_KEY` setzen oder Ollama starten. Befehl nicht gefunden? `$(npm prefix -g)/bin` zum PATH hinzufügen. MCP blockiert? `argus warden scan`. Budget überschritten? Aufgabe eingrenzen oder Limits erhöhen.

---

## 😈 Wann ARGUS nicht hilft

Drei ehrliche Gründe, warum dein Agent nein sagt.

🎬 [Animierten Cartoon ansehen →](./humor/cartoon.html?lang=de) · **[Den vollen Roast lesen →](./humor/de.md)**

---

- [Ecosystem whitepaper (EN)](https://github.com/alexar76/aicom/blob/main/docs/ecosystem/whitepaper/en.md)
- [GitHub Issues](https://github.com/alexar76/argus/issues)
- [Landing](https://magic-ai-factory.com/argus/)
