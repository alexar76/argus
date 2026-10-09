# ARGUS-3 — Guide utilisateur (Français)

> installation · configuration · usage quotidien

---

## Qu'est-ce qu'ARGUS

ARGUS-3 est votre agent IA personnel — le seul composant AICOM conçu pour la conversation directe avec les humains. Il tourne sur votre machine avec vos clés API. WARDEN vérifie chaque outil MCP avant exécution. Le reste de l'écosystème (Factory, Hub, Oracles) est autonome ; vous parlez à ARGUS.

```bash
curl -fsSL https://magic-ai-factory.com/install | bash
```

## Installation

Lancez l'installateur en une ligne. Vérifie Node.js 20+, installe `@aimarket/argus` globalement, crée `~/.argus/agent` et lance `argus setup`. L'assistant couvre : wallet crypto (optionnel, OFF par défaut), mode d'environnement, fournisseur LLM, Telegram optionnel, jeton HTTP optionnel.

## Usage quotidien

`argus doctor` — contrôle de santé. `argus ask "tâche"` — requête unique. `argus chat` — REPL interactif. `argus serve` — HTTP + Telegram + Arena. Clés dans `~/.argus/agent/.env` ; config dans `argus.config.json`.

## Comment parler à ARGUS

Rédigez des tâches claires avec une fin, pas des vibes vagues. ARGUS répond dans votre langue. Chaque tâche a un budget fixe (tokens + USD) — il termine et s'arrête. Les outils sensibles exigent une approbation explicite sur CLI/Telegram.

## Dépannage

Lancez d'abord `argus doctor`. Pas de LLM ? Ajoutez `DEEPSEEK_API_KEY` ou démarrez Ollama. Commande introuvable ? Ajoutez `$(npm prefix -g)/bin` au PATH. MCP bloqué ? Vérifiez `argus warden scan`. Budget dépassé ? Réduisez la tâche ou augmentez les limites.

---

## 😈 Quand ARGUS ne vous aidera pas

Trois raisons honnêtes pour lesquelles l'agent dit non.

🎬 [Voir le cartoon animé →](./humor/cartoon.html?lang=fr) · **[Lire le roast complet →](./humor/fr.md)**

---

- [Ecosystem whitepaper (EN)](https://github.com/alexar76/aicom/blob/main/docs/ecosystem/whitepaper/en.md)
- [GitHub Issues](https://github.com/alexar76/argus/issues)
- [Landing](https://magic-ai-factory.com/argus/)
