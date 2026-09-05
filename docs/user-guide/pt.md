# ARGUS-3 — Guia do usuário (Português)

> instalação · configuração · uso diário

---

## O que é ARGUS

ARGUS-3 é seu agente de IA pessoal — o único componente AICOM feito para conversa direta com humanos. Roda na sua máquina com suas chaves API. WARDEN verifica cada ferramenta MCP antes de executar. O resto do ecossistema (Factory, Hub, Oracles) opera de forma autônoma; você fala com o ARGUS.

```bash
curl -fsSL https://magic-ai-factory.com/install | bash
```

## Instalação

Execute o instalador de uma linha. Verifica Node.js 20+, instala `@aimarket/argus` globalmente, cria `~/.argus/agent` e inicia `argus setup`. O assistente cobre: carteira cripto (opcional, OFF por padrão), modo de ambiente, provedor LLM, Telegram opcional, token HTTP opcional.

## Uso diário

`argus doctor` — verificação de saúde. `argus ask "tarefa"` — execução única. `argus chat` — REPL interativo. `argus serve` — HTTP + Telegram + Arena. Chaves em `~/.argus/agent/.env`; config em `argus.config.json`.

## Como falar com ARGUS

Escreva tarefas claras com fim definido, não vibes vagas. ARGUS responde no idioma que você usar. Cada tarefa tem orçamento fixo (tokens + USD) — termina e para. Ferramentas sensíveis exigem aprovação explícita no CLI/Telegram.

## Solução de problemas

Execute `argus doctor` primeiro. Sem LLM? Adicione `DEEPSEEK_API_KEY` ou inicie Ollama. Comando não encontrado? Adicione `$(npm prefix -g)/bin` ao PATH. MCP bloqueado? Verifique `argus warden scan`. Orçamento excedido? Reduza a tarefa ou aumente limites na config.

---

## 😈 Quando o ARGUS não vai ajudar

Três razões honestas para o agente dizer não.

🎬 [Assistir ao cartoon animado →](./humor/cartoon.html?lang=pt) · **[Ler o roast completo →](./humor/pt.md)**

---

- [Ecosystem whitepaper (EN)](https://github.com/alexar76/aicom/blob/main/docs/ecosystem/whitepaper/en.md)
- [GitHub Issues](https://github.com/alexar76/argus/issues)
- [Landing](https://magic-ai-factory.com/argus/)
