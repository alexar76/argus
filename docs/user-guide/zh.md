# ARGUS-3 — 用户指南（中文）

> 安装 · 配置 · 日常使用

---

## 什么是 ARGUS

ARGUS-3 是您的个人 AI 智能体——AICOM 生态中唯一面向人类对话的组件。运行在您的机器上，使用您的 API 密钥。WARDEN 会在每个 MCP 工具运行前进行审查。Factory、Hub、Oracles 等其余部分自主运行；您通过 ARGUS 交互。

```bash
curl -fsSL https://magic-ai-factory.com/install | bash
```

## 安装

运行一行安装命令。检查 Node.js 20+，全局安装 `@alexar76/argus3`，创建 `~/.argus/agent`，启动 `argus setup`。向导涵盖：加密钱包（可选，默认关闭）、环境模式（`live`/`uni`/`test`）、LLM 提供商、可选 Telegram、可选 HTTP 令牌。

## 日常使用

`argus doctor` — 健康检查。`argus ask "任务"` — 单次执行。`argus chat` — 交互式 REPL。`argus serve` — HTTP + Telegram + Arena。密钥在 `~/.argus/agent/.env`，配置在 `argus.config.json`。

## 如何与 ARGUS 对话

写清楚有终点的任务，不要模糊表达。ARGUS 用您使用的语言回答。每项任务有硬性预算（token + 美元）——做完就停。敏感工具（`*payment*`、`*exec*`）在 CLI/Telegram 上需明确批准。

## 故障排除

先运行 `argus doctor`。没有 LLM？添加 `DEEPSEEK_API_KEY` 或启动 Ollama。找不到命令？将 `$(npm prefix -g)/bin` 加入 PATH。MCP 被拦？检查 `argus warden scan`。超出预算？缩小任务或提高配置中的限制。

---

## 😈 ARGUS 帮不了你的三种情况

智能体说「不」的三个诚实理由。

🎬 [观看动画短片 →](./humor/cartoon.html?lang=zh) · **[阅读完整吐槽 →](./humor/zh.md)**

---

- [Ecosystem whitepaper (EN)](https://github.com/alexar76/aicom/blob/main/docs/ecosystem/whitepaper/en.md)
- [GitHub Issues](https://github.com/alexar76/argus/issues)
- [Landing](https://magic-ai-factory.com/argus/)
