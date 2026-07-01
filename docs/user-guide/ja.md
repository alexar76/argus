# ARGUS-3 — ユーザーガイド（日本語）

> インストール · セットアップ · 日常利用

---

## ARGUSとは

ARGUS-3はあなたのパーソナルAIエージェント — 人間との直接会話のための唯一のAICOMコンポーネントです。あなたのマシンで、あなたのAPIキーで動作。WARDENはMCPツールを実行前に検査します。Factory、Hub、Oraclesなどは自律稼働；あなたはARGUSと話します。

```bash
curl -fsSL https://magic-ai-factory.com/install | bash
```

## インストール

ワンライナーインストーラを実行。Node.js 20+を確認、`@alexar76/argus3`をグローバルインストール、`~/.argus/agent`を作成、`argus setup`を起動。ウィザード：cryptoウォレット（任意、デフォルトOFF）、環境モード、LLMプロバイダー、Telegram、HTTPトークン。

## 日常利用

`argus doctor` — ヘルスチェック。`argus ask "タスク"` — ワンショット。`argus chat` — 対話REPL。`argus serve` — HTTP + Telegram + Arena。キーは `~/.argus/agent/.env`、設定は `argus.config.json`。

## ARGUSとの話し方

ゴールが明確なタスクを書く。曖昧なvibesではなく。ARGUSは使う言語で答えます。各タスクにハード予算（トークン+USD）— 終わったら止まります。センシティブツールはCLI/Telegramで明示的承認が必要。

## トラブルシューティング

まず `argus doctor`。LLMなし？ `DEEPSEEK_API_KEY` を追加するかOllama起動。command not found？ `$(npm prefix -g)/bin` をPATHに。MCPブロック？ `argus warden scan`。予算超過？ タスクを絞るか設定で上限を上げる。

---

## 😈 ARGUSが助けてくれないとき

エージェントがノーと言う3つの正直な理由。

🎬 [アニメーションを見る →](./humor/cartoon.html?lang=ja) · **[フルroastを読む →](./humor/ja.md)**

---

- [Ecosystem whitepaper (EN)](https://github.com/alexar76/aicom/blob/main/docs/ecosystem/whitepaper/en.md)
- [GitHub Issues](https://github.com/alexar76/argus/issues)
- [Landing](https://magic-ai-factory.com/argus/)
