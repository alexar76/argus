# 在 Base 上用 5 USDC 发行 Laso 美国预付卡

> 🌐 语言：[English](./use-case-laso-prepaid-card.md) · [Русский](./use-case-laso-prepaid-card-ru.md) · [Español](./use-case-laso-prepaid-card-es.md) · [Français](./use-case-laso-prepaid-card-fr.md) · **中文**

2026 年 11 月 13 日，Laso 在一次实测中发行了一张不可充值的美国预付卡。经所有者授权，一次性脚本调用 ARGUS 的 x402 支付库，从专用测试钱包在 Base 上支付了 5 USDC。Laso 先返回 `pending`，随后查询确认卡片为 `ready`，可用余额为 5 美元。另一次 itch.io 检查已到达付款页面，等待所有者完成付款。 [Laso 预付卡指南](https://docs.laso.finance/guides/usa-prepaid-card)

## 从 Base 入账到卡片就绪

测试钱包在 Base 上收到 5 USDT，此前已有 0.838158 原生 USDC。Laso 的报价使用原生 USDC。经所有者确认，操作人员用 Uniswap 定额输出兑换补足余额，然后将临时授权额度归零。

```mermaid
sequenceDiagram
    autonumber
    participant F as 入金方
    participant W as Base 测试钱包
    participant U as Uniswap 路由器
    participant L as Laso x402 API
    participant O as 所有者
    F->>W: 转入 5 USDT
    O->>W: 确认兑换与金额上限
    W->>U: 授权最多使用 4.178964 USDT
    W->>U: 兑换指定数量 4.17 USDC
    U-->>W: 扣 4.174791 USDT，入账 4.17 USDC
    W->>U: 将剩余授权额度归零
    W->>L: 请求发行 5 美元预付卡
    L-->>W: HTTP 402，报价 5 USDC
    W->>L: 提交一次 EIP-3009 授权
    L-->>W: 已结算，卡片状态 pending
    W->>L: 登录后查询卡片状态
    L-->>W: ready，可用余额 5 美元
    W-->>O: 通过已验证的 Telegram 私聊交付登录链接
```

| 步骤 | 实测结果 | 网络费用 | BaseScan 交易 |
| --- | --- | --- | --- |
| 入账 | 转入 5 USDT。 | 入金方支付 `0.000007796120104268 ETH`。 | [`0x0907…714b`](https://basescan.org/tx/0x0907b080cfd921ea9e57cb8efa6a7b9aa88fa0375c2b564c90a396106c61714b) |
| 授权 | 将 Uniswap 路由器的 USDT 使用额度设为 4.178964。 | `0.000000278888454135 ETH` | [`0xd122…229c`](https://basescan.org/tx/0xd122c5e7bb899e8adc41a1fb71f583c157ea665e9376959816239190c29f229c) |
| 兑换 | 扣除 4.174791 USDT，收到 4.17 USDC。兑换后钱包余额为 5.008158 USDC 和 0.825209 USDT。 | `0.000000766704068047 ETH` | [`0x11cb…0e3b`](https://basescan.org/tx/0x11cb25913e76087a4b3ce744ec09212b645c2755f5e3e08a58bb54cdacc60e3b) |
| 取消授权 | 将剩余 0.004173 USDT 的使用额度设为零。 | `0.000000147307564356 ETH` | [`0xae59…6b1d`](https://basescan.org/tx/0xae597e68aabc83612d488f3713e605b27c0bc74bda8ba0ad593e0a118a7b6b1d) |
| 发行 | 链上回执包含一个匹配的 EIP-3009 授权和一笔 5 USDC 转账。钱包剩余 0.008158 USDC。 | x402 结算方支付 `0.000000864119061217 ETH`。 | [`0xc8bd…9c68`](https://basescan.org/tx/0xc8bd81d9d1d39327736bc7b7a8f490658b50362aca8e295ee8cd655f20099c68) |

测试钱包支付的授权、兑换和取消授权费用合计 `0.000001192900086538 ETH`，其中包含 Base 的 L1 数据费用。核验时，公共 Base RPC 报告已最终确定的区块高度为 `56,894,431`，上述五笔交易均已达到最终确认。卡片就绪后，操作人员把有效期为 15 分钟的 Laso 登录链接发到所有者经过验证的 Telegram 私聊。所有者在 Laso 控制台的 **Cards** 栏目中查看卡片。 [Laso 控制台登录](https://docs.laso.finance/guides/authentication#getting-a-login-link-for-humans)

首次尝试在签名前停止，因为 x402 SDK 的默认单笔上限为 1 美元。修复后，ARGUS 将已校验的请求金额上限传给 SDK，并在签名前核对 Base 网络、USDC 合约、收款地址和确切金额。该修复已部署到 ARGUS。 [ARGUS 个人助理配置](./personal-assistant.md)

## ARGUS 中的操作流程

| 工具 | 行为 |
| --- | --- |
| `laso_card_quote` | 用钱包签名免费登录 Laso，检查已配置的商家是否明确标记为 `accepted`，然后生成包含商家和金额的短期报价。 |
| `laso_buy_card` | 核对报价编号和完整条款，等待所有者在私聊中批准，再提交一笔符合报价的付款。发行后，控制台链接只通过私密渠道发给所有者。 |

测试中，Laso 将 `Amazon` 标记为 `accepted`，将名称完全匹配的 `Uber` 标记为 `not_accepted`，将 `Uber Rides` 标记为 `unknown`。ARGUS 为 Amazon 生成了报价，并拒绝为 Uber 生成报价。商家结账由所有者在自己的浏览器中完成。 [Laso 商家兼容性](https://docs.laso.finance/guides/usa-prepaid-card#check-the-merchant-first) · [Laso 钱包登录](https://docs.laso.finance/guides/authentication)

## itch.io 结账验证

实测结账页面显示 Co-Working & Startup Office Icon Pack 的基础价为 `$2.99`，并提供银行卡付款选项。Laso 的商家查询将 itch.io 标记为支持这类美国预付卡。所有者在浏览器中填写收据邮箱和卡片信息，核对含税及费用的最终金额，只有总额不超过 `$5.00` 才提交付款。 [itch.io 商品页](https://aiimperium.itch.io/co-working-startup-office-icon-pack)

```mermaid
flowchart TD
    Q["确认 2.99 美元的起价和银行卡付款选项"] --> A{"最终金额不超过 5 美元？"}
    A -->|是| P["所有者确认银行卡付款"]
    A -->|否| S["停止结账"]
    P --> R["核对商家收据和最终金额"]
    P --> Z["下载 ZIP 并验证完整性"]
    P --> C["核对 Laso 扣款和可用余额"]
    R --> V["记录核验结果"]
    Z --> V
    C --> V
```

验证完成需要三项证据：

1. itch.io 显示已付款的收据。
2. 可从订单页面下载 `Co_Working_Startup_Office_Icon_Pack.zip`。商品页标示该文件为 268 kB。
3. Laso 显示金额相同的单笔卡片扣款，且余额变动与该金额一致。

银行卡付款产生商家收据和发卡方的美元扣款记录，没有单独的 Base 交易。卡片信息和私密下载链接由所有者保管。交接结账时，Laso 显示卡片状态为 `ready`、余额为 5 美元，尚无 itch.io 扣款。收据、下载和扣款仍待核验。 [Laso 卡片活动](https://laso.finance/openapi.json)

## Telegram 购买流程

配置的所有者可以在 Telegram 私聊中发送 `/buy_itch`。ARGUS 使用已配置的收据邮箱，或提示所有者直接回复邮箱。若 Laso 缺少必要的账单地址字段，机器人逐项询问。卡号与安全码由程序在付款阶段从 Laso 读取，并填入 Stripe 的支付表单。Telegram 提示不会索取这些数据。

ARGUS 从 itch.io 读取税额和最终美元总价，在私聊中显示商家、商品、金额和掩码邮箱，并要求所有者点击一次性确认按钮。总额超过 5 美元时停止。发送付款请求前，ARGUS 写入持久化记录。已有付款记录时，再次发送命令只会恢复交付或核对扣款。

ARGUS 校验 itch.io 收据、下载并检查指定 ZIP，再将文件发给所有者。若付款已发出而交付中断，所有者可在私聊中另行确认恢复交付，并回复收据中的私密下载链接。本地测试使用了模拟商家响应。Attested 生产环境已部署 Telegram 机器人和隔离的 Chromium，并配置了收据地址。Gmail 邮箱尚未连接。实测中，itch.io 在扣款前将自动结账重定向到首页。Laso 卡的余额为 5 美元，未出现该笔扣款。

## 生产环境与 ModelMarket 目录

生产环境已部署 Laso 代码。当前私有 Telegram 实例只启用了 CoinMarketCap 的付费查询，使用独立的 CMC 钱包，每笔购买都需要批准。Laso 工具尚未在该实例启用，本次发行使用另一个测试钱包。ModelMarket 的公开外部服务目录列出 CoinMarketCap、Tavily 和 Laso，并链接到各服务商的官方文档。买方使用自己的钱包直接支付给服务商。Hub 的签名清单继续列出通过 Hub 调用的能力。 [ARGUS 可选付费工具](./personal-assistant.md#optional-paid-tools) · [ModelMarket 外部服务目录](https://modelmarket.dev/ai-market/v2/external-services)
