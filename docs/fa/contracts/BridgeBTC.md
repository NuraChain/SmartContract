# BridgeBTC

> نسخهٔ انگلیسی: [../../contracts/BridgeBTC.md](../../contracts/BridgeBTC.md)

## نمای کلی قرارداد

| ویژگی | مقدار |
| --- | --- |
| نام قرارداد | `BridgeBTC` |
| فایل سولیدیتی | `contracts/token/BridgeBTC.sol` |
| نسخهٔ سولیدیتی | `^0.8.28` (solc 0.8.28، cancun) |
| نوع قرارداد | توکن ERC20 واقعی |
| هدف | بازنمایی پل‌زدهٔ BTC روی Nurachain |
| ارتقاءپذیر / پروکسی | خیر / خیر |
| وراثت | [`BridgeToken`](BridgeToken.md) |

پوستهٔ باریک و مشخص: نام `"Bridge BTC"`، نماد `"BTC"`، **۱۸ رقم اعشار** (هم‌تراز با BTCB
روی BNB Chain؛ بیت‌کوین بومی و WBTC هشت رقم اعشار دارند، پس relayer مقدارها را در `1e10` ضرب می‌کند)؛ همهٔ رفتار از [`BridgeToken`](BridgeToken.md) می‌آید.

```solidity
constructor(address admin) BridgeToken("Bridge BTC", "BTC", 18, admin) {}
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

ABI:‏ آرایهٔ `abi` در `artifacts/contracts/token/BridgeBTC.sol/BridgeBTC.json`.
