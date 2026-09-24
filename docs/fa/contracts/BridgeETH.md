# BridgeETH

> نسخهٔ انگلیسی: [../../contracts/BridgeETH.md](../../contracts/BridgeETH.md)

## نمای کلی قرارداد

| ویژگی | مقدار |
| --- | --- |
| نام قرارداد | `BridgeETH` |
| فایل سولیدیتی | `contracts/token/BridgeETH.sol` |
| نسخهٔ سولیدیتی | `^0.8.28` (solc 0.8.28، cancun) |
| نوع قرارداد | توکن ERC20 واقعی |
| هدف | بازنمایی پل‌زدهٔ ETH روی Nurachain |
| ارتقاءپذیر / پروکسی | خیر / خیر |
| وراثت | [`BridgeToken`](BridgeToken.md) |

پوستهٔ باریک و مشخص: نام `"Bridge ETH"`، نماد `"ETH"`، **۱۸ رقم اعشار** (هم‌تراز با ETH
بومی)؛ همهٔ رفتار از [`BridgeToken`](BridgeToken.md) می‌آید.

```solidity
constructor(address admin) BridgeToken("Bridge ETH", "ETH", 18, admin) {}
```

## توابع

تابع اضافه‌ای ندارد. API کامل = [`BridgeToken`](BridgeToken.md) + سطح استاندارد ERC20.

| تابع | Visibility | Mutability | دسترسی | هدف |
| --- | --- | --- | --- | --- |
| constructor(admin) | public | — | — | اعطای DEFAULT_ADMIN/MINTER/BURNER/PAUSER به `admin` |

## اطلاعات دیپلوی

- شبکه: Nurachain، شناسهٔ 1020
- آدرس: هنوز دیپلوی نشده
- اسکریپت دیپلوی: `ignition/modules/token.ts`
- بلاک/تراکنش دیپلوی: Not found in repository

## یکپارچه‌سازی

ABI:‏ آرایهٔ `abi` در `artifacts/contracts/token/BridgeETH.sol/BridgeETH.json`.
