# BridgeUSDT

> نسخهٔ انگلیسی: [../../contracts/BridgeUSDT.md](../../contracts/BridgeUSDT.md)

## نمای کلی قرارداد

| ویژگی | مقدار |
| --- | --- |
| نام قرارداد | `BridgeUSDT` |
| فایل سولیدیتی | `contracts/token/BridgeUSDT.sol` |
| نسخهٔ سولیدیتی | `^0.8.28` (solc 0.8.28، cancun) |
| نوع قرارداد | توکن ERC20 واقعی |
| هدف | بازنمایی پل‌زدهٔ USDT روی Nurachain |
| ارتقاءپذیر / پروکسی | خیر / خیر |
| وراثت | [`BridgeToken`](BridgeToken.md) |

پوستهٔ باریک و مشخص: نام `"Bridge USDT"`، نماد `"USDT"`، **۱۸ رقم اعشار**؛ آدرس `admin`
را به سازندهٔ `BridgeToken` می‌دهد که هر چهار نقش را به او اعطا می‌کند. تمام رفتار در
[BridgeToken](BridgeToken.md) مستند شده.

```solidity
constructor(address admin) BridgeToken("Bridge USDT", "USDT", 18, admin) {}
```

## نکتهٔ اعشار (اهمیت اقتصادی)

۱۸ رقم با USDT روی **BNB Chain** مطابقت دارد. USDT روی اتریوم/ترون ۶ رقمی است؛ رله باید
هنگام ضرب مقادیر را در `1e12` ضرب کند وگرنه اعتبار ۱۰¹² برابر شارژ می‌شود.

## متغیرهای State / ثابت‌ها

چیزی از خودش ندارد؛ همه از `BridgeToken` ارث می‌رسد
(`MINTER_ROLE`, `BURNER_ROLE`, `PAUSER_ROLE`, ‏`_tokenDecimals = 18`).

## توابع

جز سازنده تابعی ندارد. API کامل = [`BridgeToken`](BridgeToken.md) + سطح استاندارد ERC20.

| تابع | Visibility | Mutability | دسترسی | هدف |
| --- | --- | --- | --- | --- |
| constructor(admin) | public | — | — | اعطای DEFAULT_ADMIN/MINTER/BURNER/PAUSER به `admin` |

## اطلاعات دیپلوی

- شبکه: Nurachain، شناسهٔ 1020
- آدرس: `0x4E0DB0B1Da408faF5637202CF48b0bc7733bE6dC`
  (ثبت‌شده در `web/application/src/config/contracts.ts`)
- اسکریپت دیپلوی: `ignition/modules/token.ts` (`npm run deploy:nurachain:token`)
- بلاک/تراکنش دیپلوی: Not found in repository

## یکپارچه‌سازی

ABI در `web/application/src/config/abi/BridgeUSDT.json`. برای جریان‌ها و رویدادها
[BridgeToken](BridgeToken.md) را ببینید.
