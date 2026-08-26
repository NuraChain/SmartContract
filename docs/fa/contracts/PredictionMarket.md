# PredictionMarket

> نسخهٔ انگلیسی: [../../contracts/PredictionMarket.md](../../contracts/PredictionMarket.md)

## نمای کلی قرارداد

| ویژگی | مقدار |
| --- | --- |
| نام قرارداد | `PredictionMarket` |
| فایل سولیدیتی | `contracts/forecast/PredictionMarket.sol` |
| نسخهٔ سولیدیتی | `0.8.24` دقیق (viaIR، cancun) |
| نوع قرارداد | بازار پیش‌بینی CPMM؛ به‌صورت **کلون EIP-1167** توسط [`PredictionFactory`](PredictionFactory.md) دیپلوی و دقیقاً یک‌بار مقداردهی می‌شود |
| هدف | بازار maker با توان ثابت روی ۲ تا ۱۶ خروجی؛ وثیقه کوین بومی است؛ هر خروجی یک id از ERC-1155 است (`0..n-1`) و تأمین‌کنندگان نقدینگی توکن LP با id ‏`type(uint256).max` دارند |

**ناوردای هسته** (در هر گذار state حفظ و در تست‌ها assert می‌شود):

```text
برای هر خروجی i:‏  reserves[i] + totalUserSupply(i) == totalSets == موجودی قرارداد
```

هر عملیات خرید/فروش/نقدینگی مقدار یکسانی به جمع همهٔ خروجی‌ها اضافه/کم می‌کند، پس برابری
بین خروجی‌ها حفظ می‌شود و سهامِ برنده همیشه ۱:۱ بازخرید می‌شود. رزروها مجازی‌اند.

## وراثت

```text
PredictionMarket
├── IPredictionMarket   -- اینترفیس پیاده‌سازی‌شده
├── Initializable       -- گارد initializer برای کلون‌ها
└── ERC1155SupplyUpgradeable
    └── ERC1155Upgradeable  -- هستهٔ multi-token + عرضه به تفکیک id
```

## متغیرهای State

| متغیر | نوع | دید | تغییرپذیری | هدف |
| --- | --- | --- | --- | --- |
| `LP_TOKEN_ID` | `uint256` | public | constant | ‏id سهام LP. |
| `MAX_OUTCOMES` | `uint256` | public | constant | ‏16؛ سقف حلقه‌های هر-خروجی. |
| `MAX_FEE_BPS` | `uint16` | public | constant | ‏1000؛ حداکثر کارمزد کل ۱۰٪. |
| `controller` / `treasury` / `status` | address/address/enum | public | mutable | کارخانه، خزانه، وضعیت چرخهٔ حیات. |
| متادیتا + `creator` + سه timestamp | string/address/uint64 | public | set-once | در initialize نوشته می‌شوند؛ معامله نیازمند `block.timestamp < lockTime`. |
| `feeBps` / `protocolFeeShareBps` | uint16 | public | set-once | کارمزد کل و سهم خزانه؛ باقیمانده به LP می‌رسد. |
| `outcomeCount` | uint256 | public | set-once | تعداد خروجی‌ها n. |
| `_outcomeNames` / `_reserves` | string[] / uint256[] | private | set-once / mutable | نام‌ها / رزرو مجازی FPMM به wei. |
| `totalSets` | uint256 | public | mutable | وثیقهٔ پشت ست‌های کامل؛ برابر موجودی بومی قرارداد. |
| `_winningOutcome` | uint256 | private | در resolve ثبت | فقط وقتی Resolved معنی‌دار. |
| `_entered` | uint256 | private | mutable | قفل reentrancy مبتنی بر storage (1 آزاد / 2 داخل)؛ در initialize =1. |

## Modifierها

| Modifier | شرط | جلوگیری از | استفاده در |
| --- | --- | --- | --- |
| `onlyController` | ‏msg.sender == controller | غیرکارخانه برای چرخهٔ حیات | pause/unpause/close/resolve/void/setTreasury |
| `nonReentrant` | قفل آزاد | reentrancy در مسیرهای پولی | buy, sell, addFunding, removeFunding, mergeSets, redeem |

## رویدادها

اعلام مشترک در `PredictionEvents.sol`: ‏`LiquidityAdded`, `LiquidityRemoved`,
`PredictionPlaced`, `PredictionSold`, `RewardClaimed`, ‏`MarketPaused/Unpaused/Closed/
Resolved/Voided`. جزئیات در فایل انگلیسی همین سند.

## خطاها

مجموعهٔ کامل خطاها (ZeroAddress، ZeroAmount، InvalidOutcomeCount، InvalidOutcome،
InvalidFee، InvalidTiming، MarketNotOpen، TradingLocked، MarketNotResolved،
MarketAlreadyEnded، DeadlineExpired، SlippageExceeded، InsufficientLiquidity،
NothingToClaim، NotController، Reentrancy، TransferFailed) با شرط دقیق وقوع در جدول
نسخهٔ انگلیسی آمده است.

## توابع

### طبقه‌بندی

- **کاربر / مالی:** ‏`buy`, `sell`, `addFunding`, `removeFunding`, `mergeSets`, `redeem`
- **مدیریتی (فقط کارخانه):** ‏`pause`, `unpause`, `close`, `resolve`, `voidMarket`,
  `setTreasury`, `initialize`
- **View:** ‏`winningOutcome`, `getReserves`, `getPrices`, `calcBuy`, `calcSell`,
  `outcomeName`, `totalSets` (+ سطح ERC-1155)
- **Private:** ‏`_requireTradable`, `_requireNotEnded`, `_sendNative`

---

### initialize

```solidity
function initialize(address controller_, address treasury_, MarketParams calldata params)
    external payable initializer;
```

مقداردهی یک‌بارهٔ کلون؛ `msg.value` نقدینگی اولیهٔ LP می‌شود. اعتبارسنجی آدرس‌ها /
تعداد خروجی ۲..۱۶ / کارمزدها / ‏`now < lockTime ≤ resolveTime` / value > 0 → راه‌اندازی
ERC-1155 و `_entered=1` → کپی متادیتا → پر کردن همهٔ رزروها با seed →
`totalSets = seed` → ضرب LP برای creator → رویداد `LiquidityAdded`.
**دسترسی:** کارخانه، در همان تراکنشِ clone (بدون پنجرهٔ frontrun). سازندهٔ implementation
`_disableInitializers()` صدا می‌زند.

---

### buy

```solidity
function buy(uint256 outcomeIndex, uint256 minSharesOut, uint256 deadline)
    external payable nonReentrant returns (uint256 sharesOut);
```

خرید سهام خروجی با کوین بومی الصاقی. جریان: چک deadline → چک قابل‌معامله بودن → تفکیک
کارمزد با `FeeMath` (fee، cut پروتکل، lpFee، invest) → محاسبه با
`MarketMath.calcBuyShares` → چک slippage → effects: همهٔ رزروها += invest+lpFee؛ رزرو
خریداری‌شده -= sharesOut؛ totalSets += invest+lpFee؛ ضرب سهام → تعامل: ارسال cut به خزانه.
**امنیت:** محافظت MEV با minSharesOut+deadline؛ CEI؛ کارمزد روی ورودی واقعی.

---

### sell

```solidity
function sell(uint256 outcomeIndex, uint256 returnAmount, uint256 maxSharesIn, uint256 deadline)
    external nonReentrant returns (uint256 sharesIn);
```

معکوس خرید: سوزاندن `sharesIn` توکن خروجی و دریافت `returnAmount` خالص.
‏`grossFromNet` کارمزد را به بالا گرد می‌کند. effects: burn؛ رزرو سایر خروجی‌ها -= gross؛
رزرو خروجی فروش‌شده += sharesIn − gross؛ totalSets -= gross؛ تزریق مجدد lpFee به همهٔ
رزروها. سپس cut به خزانه و پرداخت به فروشنده. مرز slippage برعکس است: بیشینهٔ توکنی که
می‌دهید.

---

### addFunding

```solidity
function addFunding(uint256 minLpSharesOut) external payable nonReentrant returns (uint256 lpShares);
```

افزودن نقدینگی وقتی Open و قبل از lock. اگر عرضهٔ LP صفر باشد همهٔ ارزش رزرو می‌شود و
lpShares = amount؛ وگرنه متناسب با `maxReserve`: به‌ازای هر خروجی j مقدار
`keep = amount·r_j/maxR` در رزرو می‌ماند و باقیمانده به‌عنوان *توکن خروجی j* به واریزکننده
mint می‌شود (حفظ ناوردا هنگام رزروهای نامتوازن). بدون پارامتر deadline — یادداشت MEV.

---

### removeFunding

```solidity
function removeFunding(uint256 lpShares) external nonReentrant;
```

سوزاندن سهام LP و دریافت سهم تناسبی به شکل **توکن‌های خروجی**
(`out_j = r_j·lpShares/lpSupply`). تبدیل به کوین از طریق mergeSets یا نگهداری برندگان تا
حل. در هر وضعیت غیرپایانی مجاز است. **نه slippage دارد نه deadline** — شکاف مستند.

---

### mergeSets

```solidity
function mergeSets(uint256 amount) external nonReentrant;
```

سوزاندن «از هر خروجی یکی» × amount و بازگشت دقیقاً همان amount کوین (۱:۱ و بی‌کارمزد).
بعد از وضعیت پایانی مسدود است. رویداد `RewardClaimed`.

---

### redeem

```solidity
function redeem() external nonReentrant returns (uint256 payout);
```

بازخرید پس از پایان:
- **Resolved:** سوزاندن کل موجودی توکن برنده و پرداخت ۱:۱.
- **Voided:** سوزاندن موجودی‌ها در همهٔ خروجی‌ها و پرداخت `floor(Σ balances / n)`
  — دارایی‌ها را ست کامل کسری فرض می‌کند. گرد شدن به نفع استخر؛ payout به totalSets گیر
  می‌کند (در حالت‌های حدی first-come-first-served).

---

### چرخهٔ حیات (فقط controller)

`pause()/unpause()` توقف برگشت‌پذیر؛ ‏`close()` توقف دائمی؛
`resolve(uint256 w)` اعلام برنده — **حتی قبل از lockTime ممکن است** (فرض اعتمادِ مستند؛
موتور استخر این را بسته است)؛ ‏`voidMarket()` حالت بازگشت وجه؛ ‏`setTreasury`.

---

### Viewها

`winningOutcome()` (خارج از Resolved revert)، ‏`getReserves()`، ‏`getPrices()`
(قیمت‌های WAD با مجموع ≈1e18)، ‏`calcBuy(i,amountIn)` و `calcSell(i,returnAmount)`
(کوت استاتیک)، ‏`outcomeName(i)`، ‏`totalSets()`.
به‌علاوه سطح ERC-1155: ‏`balanceOf`, `balanceOfBatch`, `isApprovedForAll`,
`safeTransferFrom`, `safeBatchTransferFrom`, `setApprovalForAll`, `totalSupply(id)`,
`supportsInterface`.

## کنترل دسترسی

| تابع | دسترسی |
| --- | --- |
| buy/sell/addFunding/removeFunding/mergeSets/redeem | همه (منوط به وضعیت و lockTime) |
| چرخهٔ حیات + setTreasury | controller (کارخانه ← ADMIN_ROLE) |
| initialize | کارخانه، یک‌بار، هم‌تراکنش با clone |

## جریان مالی

```text
خریدار ──buy{value}──▶ بازار
         ├─ fee ─┬─ سهم پروتکل ──▶ Treasury.depositFee
         │        └─ lpFee ── در رزروها می‌ماند (ارزش LP)
         └─ invest ──▶ رزروها ⇄ ضرب سهام برای خریدار
فروشنده ──sell──◀ کوین (خالص کارمزد) ؛ ست‌ها سوزانده شدند
برنده ──redeem──◀ 1:1 کوین از totalSets
```

## تحلیل امنیتی

| حوزه | نتیجه |
| --- | --- |
| Reentrancy | **مشکلی دیده نشد** — قفل storage + CEI در همهٔ مسیرهای پولی |
| توانگری | **ناوردا اعمال می‌شود** — تست‌های fuzz/invariant آن را assert می‌کنند |
| گرد کردن | خرید floor سهام، فروش ceil ورودی، redeem-voided floor — استخر با گرد شدن تخلیه نمی‌شود |
| حل زودهنگام | **ملاحظهٔ طراحی/اعتماد** — resolve قبل از lockTime ممکن است؛ صحت به ADMIN_ROLE وابسته است |
| MEV | buy/sell مرز دارند؛ addFunding بی‌deadline؛ removeFunding هیچ‌مرزی ندارد — شکاف مستند |
| DoS | حلقه‌ها ≤ 16 خروجی؛ شکست send فقط payout خودِ فراخواننده را تحت تأثیر قرار می‌دهد |

## اطلاعات دیپلوی

فقط به‌صورت کلون دیپلوی می‌شود (implementation لخت توسط `ignition/modules/forecast.ts`).
آدرس کلون‌ها در رویداد `MarketCreated` منتشر می‌شود. آدرس‌های مشخص: Not found in repository.

## راهنمای یکپارچه‌سازی

قبل از معامله با `calcBuy`/`calcSell` کوت بگیرید و min*/deadline واقع‌بینانه بدهید.
پس از حل، ‏`winningOutcome()` را بخوانید و اگر سهام برنده دارید `redeem()` بزنید.
خطاهای رایج: ‏`TradingLocked` بعد از lock، ‏`SlippageExceeded` در نوسان،
`InsufficientLiquidity` فروش بزرگ به استخر نامتوازن.

## مرجع سریع توابع

| تابع | Visibility | Mutability | دسترسی | هدف |
| --- | --- | --- | --- | --- |
| `initialize(...)` | external | payable | کارخانه، یک‌بار | راه‌اندازی کلون + seed |
| `buy(i,minOut,deadline)` | external | payable | عموم (Open,<lock) | خرید سهام |
| `sell(i,ret,maxIn,deadline)` | external | nonpayable | عموم (Open,<lock) | فروش سهام |
| `addFunding(minLP)` | external | payable | عموم (Open,<lock) | افزودن نقدینگی |
| `removeFunding(lpShares)` | external | nonpayable | LP | تبدیل LP به توکن‌های خروجی |
| `mergeSets(amount)` | external | nonpayable | عموم | ست کامل ← وثیقه |
| `redeem()` | external | nonpayable | دارندگان توکن | پرداخت برنده/بازگشت |
| `pause/unpause/close/voidMarket/resolve/setTreasury` | external | nonpayable | Controller | چرخهٔ حیات |
| viewها | external | view | همه | قیمت/رزرو/کوت/نام |
