# 在 Telegram 中用 0.01 USDC 查询 CoinMarketCap 报价

> [English](./use-case-cmc-telegram.md) · [Русский](./use-case-cmc-telegram-ru.md) · [Español](./use-case-cmc-telegram-es.md) · [Français](./use-case-cmc-telegram-fr.md) · **简体中文**

2026 年 11 月 13 日，所有者在 `@Argis3Bot` 的私聊中批准了一次 CoinMarketCap 付费报价查询。查询使用比特币的 CoinMarketCap ID `1`。机器人返回了 **68,831.48 美元** 的价格、**2026 年 11 月 13 日 20:56:04 UTC** 的报价时间和 Base 交易哈希。这是机器人当时返回的历史报价。 [CoinMarketCap x402 API](https://coinmarketcap.com/api/documentation/ai-agent-hub/x402)

## 从确认到 Base 结算

```mermaid
sequenceDiagram
    actor O as Telegram 所有者
    participant A as ARGUS
    participant C as CoinMarketCap
    participant B as Base USDC 合约
    participant M as ALIEN Monitor
    O->>A: 请求比特币的美元报价，ID 1
    A-->>O: 显示 cmc_buy_quotes 及准确参数（ID 1）
    O->>A: 确认本次付费查询
    A->>C: GET 报价端点
    C-->>A: HTTP 402，返回在 Base 上以 USDC 计价的费用
    A->>A: 核对收款地址、网络和金额，签署一次 EIP-3009 授权
    A->>C: 携带授权重发 GET
    C->>B: 通过 x402 结算方执行 0.01 USDC 转账
    C-->>A: HTTP 200，返回报价和结算回执
    opt CMC 回执需要链上核验
        A->>B: 核对授权 nonce 和对应的 USDC 转账
    end
    A->>A: 验证返回的美元报价
    A-)M: 异步上报一次成功的报价查询
    A-->>O: 返回报价、时间和 Base 交易哈希
```

确认按钮授权的是参数为 `{"ids":[1]}` 的 `cmc_buy_quotes` 调用。ARGUS 校验 Base 网络、USDC 合约、已配置的 CMC 收款地址和 **0.01 USDC** 的费用上限。钱包在链下签署 EIP-3009 授权，x402 结算方提交链上交易。点击确认按钮和首次 GET 请求均不会转移资金。 [付费工具配置](./personal-assistant.md#optional-paid-tools)

| 核验项 | 结果 |
| --- | --- |
| 金额 | Base 原生 USDC `0.01`，即 `10,000` 个最小单位。专用钱包的 USDC 余额由 `0.01` 降至 `0`。 |
| 授权 | 在本次查询的核验窗口内发现一条新增的 `AuthorizationUsed` 事件，对应一笔金额相符的 USDC `Transfer`。 |
| 交易 | 正常纳入 Base 区块 `57,065,273`，三个独立 RPC 返回一致的交易和区块信息。[BaseScan 交易](https://basescan.org/tx/0x9ad76626d4ad1505363ecec1f4005e7840abdb516a3877fca39f736d81098ecc) |
| 最终性 | 核验时，三个 RPC 均已在规范链上确认这笔交易。它们报告的最终确定区块均未达到交易所在的区块。 |

[链上核验记录](../../artifacts/cmc-telegram-live-2026-11-13/verified.json) · [授权窗口核验](../../artifacts/cmc-telegram-live-2026-11-13/authorization-window.json)

ALIEN Monitor 的 `coinmarketcap/argus/quotes` 统计中，24 小时成功次数从 `0` 增至 `1`。该事件提供操作级统计，事件数据不含交易哈希或授权 nonce。 [ALIEN Monitor 统计接口](https://monitor.modelmarket.dev/api/provider-events)

使用 Node.js 22 或更新版本，在仓库根目录运行以下命令。它通过公共 Base RPC 和 ALIEN Monitor 读取核验数据。Monitor 返回查询时的统计值，上面的核验记录保留了实测时的统计和链上状态。

```sh
node artifacts/cmc-telegram-live-2026-11-13/check.mjs \
  0x9ad76626d4ad1505363ecec1f4005e7840abdb516a3877fca39f736d81098ecc
```

## 同次测试中的 Laso 结账

操作人员更新了 Laso 会话。卡片可用余额为 5 美元，未出现 itch.io 扣款。ARGUS 已配置收据邮箱。实测中，itch.io 在打开 Stripe 付款页以前把结账重定向到了首页。这次尝试没有扣款、已付款收据或 ZIP 交付。

所有者可以在自己的浏览器中完成购买，再在 `@Argis3Bot` 私聊中发送 `/recover_itch`。确认交付后，回复机器人发出的提示并附上收据里的私密下载链接。ARGUS 会核对商品、已付款金额和 ZIP，再将文件发到同一私聊。恢复交付不会产生付款。 [Laso 预付卡实测](./use-case-laso-prepaid-card-zh.md#telegram-购买流程) · [ARGUS 结账和恢复指南](./personal-assistant.md#buy-the-itchio-icon-pack-from-telegram)
