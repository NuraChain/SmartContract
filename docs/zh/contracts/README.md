# 智能合约系统 — 总览

> **English:** [`docs/contracts/README.md`](../../contracts/README.md) · **فارسی:** [`docs/fa/contracts/README.md`](../../fa/contracts/README.md)
> 每个合约的详细文档（函数、事件、错误、安全分析）以英文存放在 `docs/contracts/`。

本文档基于 `contracts/` 下的实际源码生成，覆盖仓库中的所有合约。每个一方合约在英文目录中都有完整独立文件；本页是整个系统的概要。

## 合约索引

| 合约 | 文件 | 类型 |
| --- | --- | --- |
| `BridgeToken` | contracts/token/BridgeToken.sol | 抽象 ERC20 基类 |
| `BridgeUSDT` / `BridgeBNB` | token/*.sol | 跨链桥代币（18 位小数） |
| `Airdrop` | airdrop/Airdrop.sol | EIP-712 签名的原生币空投 |
| `CollateralizedNFT` | vault/CollateralizedNFT.sol | 由单一 ERC20 支撑的 ERC721 金库 |
| `PredictionFactory` | forecast/PredictionFactory.sol | 克隆工厂 + 注册表 |
| `PredictionMarket` | forecast/PredictionMarket.sol | CPMM 预测市场 (ERC-1155) |
| `PredictionPool` | forecast/PredictionPool.sol | 帕里穆彻尔预测市场 |
| `PredictionTreasury` | forecast/PredictionTreasury.sol | 手续费金库 |
| `NuraProfile` | profile/NuraProfile.sol | 个人资料注册表（UUPS）：唯一用户名、多语言字段、扩展 |
| `FeeMath` / `MarketMath` | forecast/libraries | 数学库 |
| `WNURA` | testing/WNURA.sol | 原生币封装 (WETH9) |
| `MockToken` | testing/MockToken.sol | 测试代币 |
| Uniswap V3（第三方引入） | contracts/univ3 | 以组为单位记录的外部代码树 |

接口（`IPredictionFactory`、`IPredictionMarket`、`IPredictionPool`、
`IPredictionTreasury`、`IBackingToken`）与共享类型已在英文版的对应合约文档中说明。

## 核心架构

```text
   BridgeUSDT/BridgeBNB          PredictionFactory ──createMarket──▶ CollateralizedNFT
        ▲                             │        └─createMarket2▶ EIP-1167 克隆
        │ mint/adminBurn              │ clones                       │
   users ◀── Transfer ──── PredictionMarket   PredictionPool         │
                                   ▼                  ▼                 ▼
                            CPMM 交易/投注        投注/领取 ─▶ Treasury
```

### 两种预测引擎

二者注册于同一工厂，共享生命周期状态、金库与事件面：

| | ‏PredictionMarket（createMarket） | ‏PredictionPool（createMarket2） |
| --- | --- | --- |
| 模型 | 基于虚拟储备的恒定乘积 AMM | 帕里穆彻尔奖池 |
| 工具 | ERC-1155 结果份额 + LP 份额 | 直接下注记账 |
| 初始流动性 | 需要（payable 创建） | 无（拒绝附带价值） |
| 提前结算 | 可在 lockTime **之前**（信任假设） | 不可能 — ‏`LockNotReached` |
| 费用 | 每笔交易按 协议/LP 分成 | 结算时一次性抽成 |

## 权限模型

| 合约 | 角色 | 关键权限 |
| --- | --- | --- |
| 桥接代币 | DEFAULT_ADMIN/MINTER/BURNER/PAUSER | 无支撑增发、没收性销毁、全局暂停、救援转移 |
| Airdrop | DEFAULT_ADMIN/PAUSER/SIGNER | 抽干资金池、重新定价、暂停；签名者决定资格 |
| Vault | DEFAULT_ADMIN/MINTER + 公开铸币开关 | 未来锁定量、开放免费铸造竞赛、仅可提取**未预留部分** |
| Forecast 工厂 | ADMIN_ROLE | 创建市场（费率 ≤ 10%）、结算/作废全部市场、重定向金库 |
| 各市场 | 信任其 controller（工厂） | 生命周期仅能经工厂中继 |
| Treasury | Ownable2Step 所有者 | 提取全部手续费、更换收款人 |

每个 Ignition 模块默认把管理员角色授予部署者 — 在承载真实价值前请迁移到多签钱包。

## 主要用户流程

```text
CPMM 交易：   buy{value}(i,minOut,deadline) ─▶ fee ─▶ Treasury ；MarketResolved(w) 后：redeem()
奖池下注：    bet{value}(i) 直至 lockTime ─▶ 管理员 resolve ─▶ 获胜者 claim() 按比例分配
跨链桥：      中继者在入金时 mint；BURNER 在出金时 burn
Vault：       deposit ─▶ mint NFT（预留 lockAmount） ── redeem 向持有者付款
空投：        后端签署 Claim(account,deadline) ─▶ getReward() ─▶ 原生币支付
```

## 已记录的部署信息

| 合约 | 网络 | 地址 |
| --- | --- | --- |
| BridgeUSDT | Nurachain 1020 | 0x4E0DB0B1Da408faF5637202CF48b0bc7733bE6dC |
| BridgeBNB | Nurachain 1020 | 0xD4221Ad9772BF5bA7423a044bBBEe6af2154A5Fc |
| WNURA | Nurachain 1020 | 0xf0a4eC07916feBa4432121Ed5969887D9b939cD0 |
| Multicall3 | Nurachain 1020 | 0xf58884FCf45d8F5Cc8A73c618D23EB27b732CA24 |
| 其余 | Nurachain 1020 | 仓库中未记录 — 部署时登记 |

## 整体安全态势

- 全库无代理/升级机制；行为在部署时固定。
- 克隆实现调用 `_disableInitializers()`，初始化与创建原子完成。
- 资金路径遵循 checks-effects-interactions 并使用存储型重入锁。
- 舍入始终有利于资金池/金库。
- 持续存在的风险是中心化：结算、增发、暂停与提现最终都归结于管理员密钥。

```text
Documentation completed.  （中文为系统概要；完整参考见英文文档）

Missing documentation:    0
```
