# ARGUS-3 🛡️

> 🌐 [English](README.md) · [Русский](README-ru.md) · [Español](README-es.md) · [Français](README-fr.md) · **中文** · [术语表](https://github.com/alexar76/aicom/blob/main/docs/localization-glossary.md)


**面向 AICOM 经济的、钱包原生、经安全加固的个人智能体。**

ARGUS-3 是智能体经济一直缺少的**需求侧参考客户端**。生态已有生产方（Factory）、经纪人（**Hub**）、定价（**ACEX**）、信任数学（预言机）与可观测性（**Alien Monitor**）。缺的是普通人能启动的智能体：能**发现、支付、消费并出售** capability 的智能体。这就是 ARGUS。

它建立在典型 MCP 客户端通常没有的两层之上：

1. **🛡️ WARDEN** — MCP **防火墙**：用本地可验证的信息检查第三方服务器（分层静态扫描工具定义、签名威胁源、公告**来源（origin）**、相对钉扎快照的漂移）。**无需钱包、无需链、无需网络。**
2. **💸 原生结算** — 通过现有 AIMarket **托管（escrow）** 用 Base 上的 USDC 为 **调用（invoke）** 付款/收款，并**复用** `@aimarket/agent` SDK。

同时保持节俭（预算治理 + 实时令牌计数器），可对接**任意模型**，并在经济不可用时**完全自治**。

## ARGUS 有何不同

| | 做什么 | 为何重要 |
|---|---|---|
| 🛡️ **WARDEN 防火墙** | 每个 MCP 服务器经 static → threat → origin → pinning 才暴露工具 | 默认阻断工具投毒、rug-pull、渗出 |
| 💸 **原生 + 自治经济** | discover → openChannel → invoke → settle；有钱包才加载 | 真正的双边市场；无钥匙则零经济故障面 |
| ⚖️ **可审计的节俭** | $/令牌上限、模型分层、`cache_control`、压缩、实时计数器 | 超限即停任务 — 从不静默超支 |
| 🌐 **任意提供方** | Anthropic-native、OpenAI 兼容、本地 Ollama | 你的密钥、模型与成本 |

## 快速开始

```bash
cd argus && npm install && npm run build
cp argus.config.example.json argus.config.json && cp .env.example .env
node dist/index.js doctor
node dist/index.js ask "summarise https://example.com in three bullets"
```

无 `ARGUS_WALLET_KEY` 时 `economy: OFF (autonomous)`。见 [docs/autonomy.md](docs/autonomy.md)。

## 架构

五层；自治线以上可离线；经济层仅在有钱包时挂接。详见 [docs/architecture.md](docs/architecture.md)。

## 🛡️ WARDEN

> WARDEN 已作为 **[`@aimarket/warden`](https://github.com/alexar76/warden)** 独立发布——一个零依赖库，
> 你可以把它放在自己的 MCP 宿主前面，而不必换用 ARGUS。ARGUS 依赖该包；本节讲的是它在智能体内部做什么。

工具*描述*是对手可控文本。WARDEN 默认敌意，经 static → threat feed → origin → pinning。见 [docs/security-warden.md](docs/security-warden.md)。

## 💸 经济集成

```bash
export ARGUS_WALLET_KEY=0x...
node dist/index.js economy discover "translate to 5 languages" --budget 1
```

消费方：`discover → openChannel (USDC/Base) → invoke → settle`。见 [docs/economy-integration.md](docs/economy-integration.md)。

## Agent Arena

XP、等级、每日连胜、任务/徽章、Flex Card、可选排行榜。指标来自本地记忆 + 签名**收据**。演示：[magic-ai-factory.com/arena](https://magic-ai-factory.com/arena)。

## 通道

CLI / Telegram / HTTP (`argus serve`) / MCP (`argus mcp`)。矩阵见 [docs/channels.md](docs/channels.md)。

## Docker

```bash
docker compose up -d --build
```

## 许可

MIT — 你的密钥、基础设施与数据。属于 [AICOM 开放智能体经济](https://magic-ai-factory.com)。
