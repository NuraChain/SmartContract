# ماک‌های تست و قراردادهای Vendored

> نسخهٔ انگلیسی: [../../contracts/TestAndVendoredContracts.md](../../contracts/TestAndVendoredContracts.md)

این قراردادها در مخزن هستند اما **سطح قابل‌دیپلویِ پروتکل نیستند**: یا برای مجموعه‌های
تست‌اند یا کد third-party وندورشده.

## ماک‌های تست (first-party، فقط تست)

| فایل | قرارداد | نقش |
| --- | --- | --- |
| `contracts/forecast/mocks/ReentrantBuyer.sol` | `ReentrantBuyer` | در حین callback تلاش به buy مجدد روی کلون PredictionMarket می‌کند؛ اثبات سلامت قفل reentrancy مبتنی بر storage. |
| `contracts/airdrop/mocks/AirdropMocks.sol` | `IAirdrop` (اینترفیس)، ‏`ReentrantClaimer`, `RejectingClaimer` | اولی از مسیر receive دوباره getReward می‌زند (با گارد + CEI بسته می‌شود)؛ دومی پرداخت را رد می‌کند تا ثابت شود send ناموفق state ادعا را خراب نمی‌کند. |
| `contracts/vault/mocks/VaultMocks.sol` | `MockConfigurableERC20`, `MockReentrantERC20`, `MockReentrantReceiver` | ERC20های بدرفتار (هوک انتقال که به deposit/redeem برمی‌گردد) و گیرندهٔ ERC-721ای که هنگام mint re-entry می‌کند؛ مصرف Vault.test.ts و مجموعه‌های fuzz/invariant سولیدیتی. |

هیچ‌کدام در دیپلوی‌های production وجوه نگه نمی‌دارند و هیچ ماژول Ignitionی به آن‌ها
اشاره نمی‌کند.

## Vendored: یونی‌سواپ V3 ‏(`contracts/univ3/`)

هسته + periphery یونی‌سواپ V3 عیناً وندور شده با بازنویسی importهای پکیجی به مسیر نسبی،
به‌علاوه یک تغییر محلیِ مستند (شاخهٔ `chainId == 1020` در
`NonfungibleTokenPositionDescriptor.tokenRatioPriority` — همان رفتاری که آپ‌استریم برای
توکن‌های پل‌زدهٔ اتریوم دارد). منشأ، مجوزها (GPL-2.0-or-later برای V3، فایل‌های BUSL
منقضی‌شده، زیرمجموعه‌های MIT/GPL-3 vendor) و هر تغییر محلی در
[`contracts/univ3/VENDORED.md`](../../../contracts/univ3/VENDORED.md) ثبت است.

نقاط ورود قابل‌دیپلوی (مستندسازی کامل نزد مستندات خود یونی‌سواپ):

| قرارداد | مسیر | هدف |
| --- | --- | --- |
| `UniswapV3Factory` | ‏univ3/core | ساخت یک استخر به ازای هر (جفت توکن، tier کارمزد) |
| `UniswapV3Pool` | univ3/core | استخر نقدینگی متمرکز (توسط کارخانه دیپلوی می‌شود) |
| `NonfungiblePositionManager` | periphery | موقعیت‌های نقدینگی به شکل ERC-721 |
| `SwapRouter` | periphery | سواپ exact-in/exact-out تک و چند-استخری |
| `QuoterV2` | periphery/lens | کوت با شبیه‌سازی + revert (فقط static-call) |
| `TickLens`, `NFTDescriptor`, `NonfungibleTokenPositionDescriptor` | periphery | ابزار و متادیتا |

محدودیت‌های بیلد (حیاتی): دقیقاً solc **0.7.6**، تنظیمات optimizer آپ‌استریم،
`metadata.bytecodeHash: "none"`، ‏evmVersion ‏istanbul — این‌ها hash مقداردهی استخر را
بایت‌به‌بایت با عدد منتشرشدهٔ یونی‌سواپ یکی نگه می‌دارند و همهٔ قراردادها را زیر سقف
EIP-170 نوراچین (۲۴۵۷۶ بایت) جا می‌دهند (assert در `test/univ3/Build.test.ts`).
مستندسازی عمیق per-contract عمداً تکرار نشده؛ به مستندات رسمی Uniswap V3 مراجعه کنید.
