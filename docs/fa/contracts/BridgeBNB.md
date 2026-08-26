# BridgeBNB

> نسخهٔ انگلیسی: [../../contracts/BridgeBNB.md](../../contracts/BridgeBNB.md)

## نمای کلی قرارداد

| ویژگی | مقدار |
| --- | --- |
| نام قرارداد | `BridgeBNB` |
| فایل سولیدیتی | `contracts/token/BridgeBNB.sol` |
| نسخهٔ سولیدیتی | `^0.8.28` (solc 0.8.28، cancun) |
| نوع قرارداد | توکن ERC20 واقعی |
| هدف | بازنمایی پل‌زدهٔ BNB روی Nurachain |
| ارتقاءپذیر / پروکسی | خیر / خیر |
| وراثت | [`BridgeToken`](BridgeToken.md) |

پوستهٔ باریک و مشخص: نام `"Bridge BNB"`، نماد `"BNB"`، **۱۸ رقم اعشار** (هم‌تراز با BNB
بومی)؛ همهٔ رفتار از [`BridgeToken`](BridgeToken.md) می‌آید.

```solidity
constructor(address admin) BridgeToken("Bridge BNB", "BNB", 18, admin) {}
```

## توابع

تابع اضافه‌ای ندارد. API کامل = [`BridgeToken`](BridgeToken.md) + سطح استاندارد ERC20.

| تابع | Visibility | Mutability | دسترسی | هدف |
| --- | --- | --- | --- | --- |
| constructor(admin) | public | — | — | اعطای DEFAULT_ADMIN/MINTER/BURNER/PAUSER به `admin` |

## اطلاعات دیپلوی

- شبکه: Nurachain، شناسهٔ 1020
- آدرس: `0xD4221Ad9772BF5bA7423a044bBBEe6af2154A5Fc`
  (ثبت‌شده در `web/application/src/config/contracts.ts`)
- اسکریپت دیپلوی: `ignition/modules/token.ts`
- بلاک/تراکنش دیپلوی: Not found in repository

## یکپارچه‌سازی

ABI در `web/application/src/config/abi/BridgeBNB.json`.
