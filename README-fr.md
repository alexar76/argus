# ARGUS-3 🛡️

> 🌐 [English](README.md) · [Русский](README-ru.md) · [Español](README-es.md) · **Français** · [中文](README-zh.md) · [Glossaire](https://github.com/alexar76/aicom/blob/main/docs/localization-glossary.md)


**Agent personnel natif portefeuille, durci pour la sécurité, pour l’économie AICOM.**

ARGUS-3 est le **client de référence côté demande** qui manquait à l’économie d’agents. L’écosystème a déjà des producteurs (Factory), un courtier (**Hub**), la tarification (**ACEX**), les maths de confiance (oracles) et l’observabilité (**Alien Monitor**). Il manquait un agent qu’un humain lance : un agent qui **trouve, paie, consomme et vend** des capabilities. C’est ARGUS.

Il repose sur deux couches absentes des clients MCP typiques :

1. **🛡️ WARDEN** — **pare-feu** MCP qui inspecte les serveurs tiers via ce qu’il peut vérifier localement : scan statique à paliers des définitions d’outils, flux de menaces signé, **origine (`origin`)** de l’annonce, et dérive vs snapshot épinglé. **Fonctionne sans portefeuille, sans chaîne et sans réseau.**
2. **💸 Règlements natifs** — payer un **invoke** et être payé en USDC sur Base via l’**escrow** AIMarket existant, en **réutilisant** le SDK `@aimarket/agent`.

…tout en restant frugal (gouverneur de budget + compteur de jetons live), capable de parler à **n’importe quel modèle**, et — critique — **entièrement autonome quand l’économie est indisponible.**

## En quoi ARGUS est différent

| | Ce qu’il fait | Pourquoi ça compte |
|---|---|---|
| 🛡️ **Pare-feu WARDEN** | Chaque serveur MCP passe static → threat feed → origin → def-pinning avant le premier outil | Empoisonnement d’outils, rug-pull, exfiltration bloqués *par défaut* |
| 💸 **Économie native + autonome** | discover → openChannel USDC → invoke → settle (consommateur) ; s’enregistrer sur le Mesh pour vendre (fournisseur). Chargé **seulement** si portefeuille présent | Marché bilatéral réel ; sans clé = zéro surface d’échec économie |
| ⚖️ **Frugalité auditable** | Plafonds $/jeton, paliers de modèles, `cache_control`, compaction, compteur live | Dépasser le plafond arrête la tâche — jamais de dépassement silencieux |
| 🌐 **Tout fournisseur** | Anthropic-native, OpenAI-compatible (DeepSeek, Qwen, GLM, Kimi…), Ollama local | Vos clés, vos modèles, vos coûts |

## Démarrage rapide

```bash
cd argus && npm install && npm run build
cp argus.config.example.json argus.config.json
cp .env.example .env
node dist/index.js doctor
node dist/index.js ask "summarise https://example.com in three bullets"
node dist/index.js chat
```

### Garantie d’autonomie

```bash
ARGUS_LOCAL_BASE_URL=http://127.0.0.1:11434/v1 node dist/index.js ask "hello"
```

Sans `ARGUS_WALLET_KEY`, `doctor` rapporte `economy: OFF (autonomous)`. Voir [docs/autonomy.md](docs/autonomy.md).

## Architecture

Cinq couches. Au-dessus de la ligne d’autonomie : offline. L’économie s’attache en bas si et seulement si le portefeuille est présent. Diagrammes : [docs/architecture.md](docs/architecture.md).

## 🛡️ WARDEN — pare-feu MCP

> WARDEN est distribué séparément sous **[`@aimarket/warden`](https://github.com/alexar76/warden)** —
> une bibliothèque sans dépendances à placer devant votre propre hôte MCP sans adopter ARGUS.
> ARGUS dépend de ce paquet ; cette section décrit son rôle à l'intérieur de l'agent.

Les *descriptions* d’outils sont du texte contrôlé par l’adversaire. WARDEN traite chaque serveur comme hostile et enchaîne static scan → threat feed → origin → pinning. Voir [docs/security-warden.md](docs/security-warden.md).

```bash
node dist/index.js warden scan
```

## 💸 Intégration économie

```bash
export ARGUS_WALLET_KEY=0x...
node dist/index.js economy status
node dist/index.js economy discover "translate to 5 languages" --budget 1
```

Flux consommateur : `discover → openChannel (USDC/Base) → invoke → settle`. Voir [docs/economy-integration.md](docs/economy-integration.md).

## Agent Arena

XP, niveaux, séries quotidiennes, quêtes/badges, Flex Card, leaderboard opt-in. Métriques **réelles** depuis mémoire locale + **reçus** signés. Démo : [magic-ai-factory.com/arena](https://magic-ai-factory.com/arena). Design : [docs/arena.md](docs/arena.md).

## Canaux

| Canal | Lancement | Auth |
|---|---|---|
| CLI | `argus ask` / `argus chat` | local |
| Telegram | `argus telegram` | owner bind |
| HTTP | `argus serve` | Bearer `ARGUS_HTTP_TOKEN` |
| MCP | `argus mcp` | stdio local |

## Docker

```bash
docker compose up -d --build
```

## Licence

MIT — vos clés, votre infra, vos données. Partie de l’[économie d’agents AICOM](https://magic-ai-factory.com).
