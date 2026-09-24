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
برای هر خروجی i:‏  reserves[i] + totalUserSupply(i) == totalSets == موجودی قرارداد − heldFees
```

هر عملیات خرید/فروش/نقدینگی مقدار یکسانی به جمع همهٔ خروجی‌ها اضافه/کم می‌کند، پس برابری
بین خروجی‌ها حفظ می‌شود و سهامِ برنده همیشه ۱:۱ بازخرید می‌شود. رزروها مجازی‌اند.

این ناوردا تا آخر عمر بازار برقرار است، از جمله در پنجرهٔ یک‌سالهٔ بازخرید که با
تعیین‌تکلیف بازار باز می‌شود. ‏`sweepUnclaimed` آن را بازنشسته می‌کند: بعد از بسته‌شدن آن
پنجره دیگر چیزی بازخرید نمی‌شود، پس باقیماندهٔ وثیقه و `totalSets` با هم صفر می‌شوند و
موجودی سهام‌های باقی‌مانده صرفاً یک ثبتِ بی‌اثر است.

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
| `CLAIM_WINDOW` | `uint64` | public | constant | ‏365 روز؛ مهلت بازخرید برندگان پس از تعیین‌تکلیف بازار. |
| `controller` / `treasury` / `status` | address/address/enum | public | mutable | کارخانه، خزانه، وضعیت چرخهٔ حیات. |
| متادیتا + `creator` + سه timestamp | string/address/uint64 | public | set-once | در initialize نوشته می‌شوند؛ معامله نیازمند `block.timestamp < lockTime`. |
| `categoryId` | uint32 | public | set-once | دستهٔ بازار در [رجیستری کارخانه](PredictionFactory.md#رجیستری-دسته‌ها)؛ خودِ بازار هیچ نامی برای دسته ذخیره نمی‌کند. |
| `feeBps` | uint16 | public | set-once | کارمزد کل معامله؛ تا تعیین‌تکلیف در امانت می‌ماند، با resolve به خزانه می‌رود و با void برمی‌گردد. |
| `outcomeCount` | uint256 | public | set-once | تعداد خروجی‌ها n. |
| `_outcomeNames` / `_reserves` | string[] / uint256[] | private | set-once / mutable | نام‌ها / رزرو مجازی FPMM به wei. |
| `totalSets` | uint256 | public | mutable | وثیقهٔ پشت ست‌های کامل؛ موجودی بومی قرارداد منهای `heldFees`. |
| `heldFees` | uint256 | public | mutable | کارمزدهای گرفته‌شده که در امانت مانده‌اند. با `resolve` به خزانه می‌روند و با `voidMarket` به صندوق بازگشت وجه اضافه می‌شوند. |
| `endedAt` | uint64 | public | در resolve/void ثبت | زمان تعیین‌تکلیف؛ تا وقتی بازار زنده است صفر. مبدأ پنجرهٔ بازخرید. |
| `_deposited` (private) | mapping | mutable | وثیقهٔ خالصی که هر حساب وارد بازار کرده: به اندازهٔ پولی که با seed و `buy` (با کارمزد) و `addFunding` پرداخته بالا می‌رود، و به اندازهٔ پولی که با `sell` و `mergeSets` گرفته پایین. همین چیزی است که void پس می‌دهد. با `depositOf` خوانده می‌شود. |
| `_totalDeposited` (private) | uint256 | mutable | مجموع `_deposited`. سهام توکن ERC-1155 معمولی و قابل انتقال است و دفتر نمی‌تواند دنبالش برود، پس برداشت روی سپردهٔ خودِ فروشنده متوقف می‌شود به‌جای underflow؛ در نتیجه این عدد **کران بالای** `totalSets` است، نه مساوی آن. |
| `_shareBasis` / `_sharePot` (private) | uint256 | در تعیین‌تکلیف ثبت | مخرج و صورتِ سهم تناسبی‌ای که تعیین‌تکلیف پرداخت می‌کند. در resolve: عرضهٔ LP روی `reserves[win]`. در void: ‏`_totalDeposited` روی `totalSets`. اسنپ‌شات گرفته می‌شود چون بازخرید هر دو عدد زنده را جابه‌جا می‌کند. |
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
Resolved/Voided`، و ‏`UnclaimedSwept(market, treasury, amount)` هنگام جاروی باقیمانده.
جزئیات در فایل انگلیسی همین سند.

## خطاها

مجموعهٔ کامل خطاها (ZeroAddress، ZeroAmount، InvalidOutcomeCount، InvalidOutcome،
InvalidFee، InvalidTiming، MarketNotOpen، TradingLocked، MarketNotResolved،
MarketAlreadyEnded، DeadlineExpired، SlippageExceeded، InsufficientLiquidity،
NothingToClaim، NotController، Reentrancy، TransferFailed) با شرط دقیق وقوع در جدول
نسخهٔ انگلیسی آمده است. دو خطای پنجرهٔ بازخرید هم به این مجموعه اضافه شده‌اند:
`ClaimWindowOpen()` وقتی جارو پیش از `endedAt + CLAIM_WINDOW` صدا زده شود، و
`ClaimWindowClosed()` وقتی `redeem` در/پس از همان لحظه صدا زده شود.

## توابع

### طبقه‌بندی

- **کاربر / مالی:** ‏`buy`, `sell`, `addFunding`, `removeFunding`, `mergeSets`, `redeem`
- **مدیریتی (فقط کارخانه):** ‏`pause`, `unpause`, `close`, `resolve`, `voidMarket`,
  `setTreasury`, `sweepUnclaimed`, `initialize`
- **View:** ‏`winningOutcome`, `claimDeadline`, `pendingPayout`, `depositOf`,
  `getReserves`, `getPrices`, `calcBuy`, `calcSell`, `outcomeName`,
  `totalSets` (+ سطح ERC-1155)
- **Private:** ‏`_requireTradable`, `_requireNotEnded`, `_requireClaimWindowOpen`,
  `_withdrawDeposit`, `_payoutOf`, `_settleAccount`, `_sendNative`

**هیچ‌چیز push نمی‌شود.** تعیین‌تکلیف فقط مشخص می‌کند چه کسی چقدر طلبکار است؛ هر wei
فقط با `redeem` خودِ شرکت‌کننده از بازار بیرون می‌رود.

---

### initialize

```solidity
function initialize(address controller_, address treasury_, MarketParams calldata params)
    external payable initializer;
```

مقداردهی یک‌بارهٔ کلون؛ `msg.value` نقدینگی اولیهٔ LP می‌شود. اعتبارسنجی آدرس‌ها /
تعداد خروجی ۲..۱۶ / کارمزدها / ‏`now < lockTime ≤ resolveTime` / value > 0 → راه‌اندازی
ERC-1155 و `_entered=1` → کپی متادیتا → پر کردن همهٔ رزروها با seed →
`totalSets = seed` → ثبت seed به نام `creator` در دفتر سپرده → ضرب LP برای creator →
رویداد `LiquidityAdded`.
**دسترسی:** کارخانه، در همان تراکنشِ clone (بدون پنجرهٔ frontrun). سازندهٔ implementation
`_disableInitializers()` صدا می‌زند.

---

### buy

```solidity
function buy(uint256 outcomeIndex, uint256 minSharesOut, uint256 deadline)
    external payable nonReentrant returns (uint256 sharesOut);
```

خرید سهام خروجی با کوین بومی الصاقی. جریان: چک deadline → چک قابل‌معامله بودن → تفکیک
کارمزد با `FeeMath` (fee و invest = amountIn − fee) → محاسبه با
`MarketMath.calcBuyShares` → چک slippage → effects: همهٔ رزروها += invest؛ رزرو
خریداری‌شده -= sharesOut؛ totalSets += invest؛ ‏heldFees += fee؛ افزودن کل amountIn به
دفتر سپردهٔ خریدار؛ ضرب سهام. فراخوانی خارجی ندارد: کارمزد تا تعیین‌تکلیف در امانت می‌ماند.
**امنیت:** محافظت MEV با minSharesOut+deadline؛ CEI؛ کارمزد روی ورودی واقعی.

---

### sell

```solidity
function sell(uint256 outcomeIndex, uint256 returnAmount, uint256 maxSharesIn, uint256 deadline)
    external nonReentrant returns (uint256 sharesIn);
```

معکوس خرید: سوزاندن `sharesIn` توکن خروجی و دریافت `returnAmount` خالص.
‏`grossFromNet` کارمزد را به بالا گرد می‌کند. effects: burn؛ رزرو سایر خروجی‌ها -= gross؛
رزرو خروجی فروش‌شده += sharesIn − gross؛ totalSets -= gross؛ ‏heldFees += fee؛ کم شدن
returnAmount (پولی که واقعاً خارج شد) از دفتر سپردهٔ فروشنده، با توقف روی صفر (ممکن است
سهامی را بفروشد که کس دیگری خریده). سپس پرداخت به فروشنده؛ کارمزد در امانت می‌ماند. مرز
slippage برعکس است: بیشینهٔ توکنی که می‌دهید.

---

### addFunding

```solidity
function addFunding(uint256 minLpSharesOut) external payable nonReentrant returns (uint256 lpShares);
```

افزودن نقدینگی وقتی Open و قبل از lock. اگر عرضهٔ LP صفر باشد همهٔ ارزش رزرو می‌شود و
lpShares = amount؛ وگرنه متناسب با `maxReserve`: به‌ازای هر خروجی j مقدار
`keep = amount·r_j/maxR` در رزرو می‌ماند و باقیمانده به‌عنوان *توکن خروجی j* به واریزکننده
mint می‌شود (حفظ ناوردا هنگام رزروهای نامتوازن). `amount` به دفتر سپردهٔ واریزکننده هم
افزوده می‌شود. بدون پارامتر deadline — یادداشت MEV.

---

### removeFunding

```solidity
function removeFunding(uint256 lpShares) external nonReentrant;
```

سوزاندن سهام LP و دریافت سهم تناسبی به شکل **توکن‌های خروجی**
(`out_j = r_j·lpShares/lpSupply`). تبدیل به کوین از طریق mergeSets یا نگهداری برندگان تا
حل. دفتر سپرده دست‌نخورده می‌ماند: نه چیزی وارد شده نه خارج. در هر وضعیت غیرپایانی مجاز
است. **نه slippage دارد نه deadline** — شکاف مستند.

---

### mergeSets

```solidity
function mergeSets(uint256 amount) external nonReentrant;
```

سوزاندن «از هر خروجی یکی» × amount و بازگشت دقیقاً همان amount کوین (۱:۱ و بی‌کارمزد)؛
همان amount هم از دفتر سپردهٔ فراخواننده کم می‌شود، با توقف روی صفر. بعد از وضعیت پایانی
مسدود است. رویداد `RewardClaimed`.

---

### redeem

```solidity
function redeem() external nonReentrant returns (uint256 payout);
```

تنها راهی که وثیقه از بازارِ تعیین‌تکلیف‌شده بیرون می‌رود. هیچ‌چیز push نمی‌شود؛ هر
شرکت‌کننده خودش می‌آید و سهم خودش را — یک‌بار — برمی‌دارد.

- **Resolved:** سوزاندن کل موجودی توکن برنده و پرداخت ۱:۱، به‌علاوهٔ سهم تناسبی او از
  استخر LP (‏`lpBalance · _sharePot / _shareBasis`) با سوزاندن سهام LP‌اش. تقسیم دقیق
  است: در لحظهٔ حل ‏`reserves[win] + totalSupply(win) == totalSets`، پس پرداخت ۱:۱ به هر
  سهم برنده و دادن `reserves[win]` به LPها وثیقه را تا آخرین wei تقسیم می‌کند.
- **Voided:** سهام و سهم LP اصلاً به حساب نمی‌آیند. فراخواننده سپردهٔ خودش را پس
  می‌گیرد — ‏`_deposited · _sharePot / _shareBasis` — و سطر دفترش صفر می‌شود. همین
  مقیاس‌گذاری است که توانگری را نگه می‌دارد: ‏`_totalDeposited` فقط می‌تواند *جلوتر* از
  صندوق باشد (معامله‌گری که با سود فروخته، تفاوت را با خودش برده)، پس ضریب ≤ ۱ است و
  دقیقاً ۱ می‌شود هر وقت کسی بیشتر از آنچه آورده بیرون نبرده باشد. کارمزدها هم برمی‌گردند:
  ‏`voidMarket` مقدار `heldFees` را به `totalSets` برمی‌گرداند، پس بازار void‌شده برای
  معامله‌گران جز هزینهٔ گس خرجی ندارد.

گرد شدن به نفع استخر؛ payout به totalSets گیر می‌کند. پاک‌کردن مبنای ادعا (سوزاندن، یا
صفر کردن سطر دفتر) است که پرداخت را یک‌باره می‌کند: فراخوانی دوم چیزی نمی‌بیند و
`NothingToClaim` می‌دهد. یک سال پس از تعیین‌تکلیف بازار هم `ClaimWindowClosed` می‌دهد
(به `sweepUnclaimed` نگاه کنید).

> **void به چه کسی پرداخت می‌کند.** دفتر دنبال پول است، نه دنبال توکن. خرید سهام از
> دارندهٔ دیگر روی ERC-1155، *موقعیت* او را می‌خرد نه ادعای بازگشت وجهش را — بازگشت وجه
> پیش کسی می‌ماند که پول را به بازار داده. بازارهایی که انتظار بازار ثانویهٔ سهام دارند
> باید resolve شوند، نه void.

---

### sweepUnclaimed

```solidity
function sweepUnclaimed() external onlyController nonReentrant returns (uint256 amount);
```

تعیین‌تکلیف بازار (`resolve` یا `voidMarket`) زمان `endedAt` را ثبت می‌کند و پنجرهٔ
`CLAIM_WINDOW` به طول یک سال از همان‌جا شروع می‌شود. در این یک سال `redeem` دقیقاً مثل
قبل کار می‌کند و هیچ‌کس نمی‌تواند به وثیقهٔ بازار دست بزند. در `claimDeadline()` ورق
برمی‌گردد: `redeem` برای همه `ClaimWindowClosed` می‌دهد و ادمین می‌تواند باقیمانده را
بردارد.

- تا وقتی `endedAt == 0` است `MarketNotResolved` می‌دهد (بازار زندهٔ هرگز جارو نمی‌شود).
- پیش از مهلت `ClaimWindowOpen`، و وقتی چیزی نمانده باشد `ZeroAmount`.
- کل `address(this).balance` را جارو می‌کند، نه فقط `totalSets`: هرچه به‌زور به قرارداد
  فرستاده شده باشد قابل بازخرید نیست و بعد از پایان پنجره هم حسابداری‌ای برای محافظت
  نمانده. `totalSets` را صفر می‌کند، کل مبلغ را با `IPredictionTreasury.depositFee` به
  خزانه می‌فرستد و `UnclaimedSwept` را emit می‌کند.

بریدگی روی خودِ مهلت است، نه روی تراکنش جارو؛ پس بازخرید برای همه در یک لحظهٔ واحد بسته
می‌شود، چه ادمین باقیمانده را برداشته باشد چه نه.

---

### چرخهٔ حیات (فقط controller)

`pause()/unpause()` توقف برگشت‌پذیر؛ ‏`close()` توقف دائمی؛
`resolve(uint256 w)` اعلام برنده — **حتی قبل از lockTime ممکن است** (فرض اعتمادِ مستند؛
موتور استخر این را بسته است) و `heldFees` را به خزانه می‌فرستد؛ ‏`voidMarket()` باز کردن
بازار: هرکس سپردهٔ خودش را همراه کارمزد پس می‌گیرد؛ ‏`setTreasury`؛ ‏`sweepUnclaimed()` انتقال باقیمانده به خزانه، فقط بعد از
`endedAt + CLAIM_WINDOW`.

‏`removeFunding` دیگر بعد از تعیین‌تکلیف کار نمی‌کند (`MarketAlreadyEnded`): از آن به بعد
سهام LP را خودِ `redeem` به‌صورت وثیقه پرداخت می‌کند، و تبدیلش به توکن خروجی یعنی پرداخت
دوبارهٔ همان رزروها.

---

### Viewها

`winningOutcome()` (خارج از Resolved revert)، ‏`getReserves()`، ‏`getPrices()`
(قیمت‌های WAD با مجموع ≈1e18)، ‏`calcBuy(i,amountIn)` و `calcSell(i,returnAmount)`
(کوت استاتیک)، ‏`outcomeName(i)`، ‏`totalSets()`، ‏`endedAt()`، ‏`claimDeadline()`
(برابر `endedAt + CLAIM_WINDOW`، و تا وقتی بازار زنده است صفر)،
‏`pendingPayout(account)` (سهم آن حساب؛ تا وقتی بازار زنده است یا پس از پرداخت، صفر)،
‏`depositOf(account)` (وثیقهٔ خالصی که آن حساب گذاشته — همان چیزی که void پس می‌دهد) و
`categoryId()`.
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
         ├─ fee ──▶ heldFees (امانت)
         └─ invest ──▶ رزروها ⇄ ضرب سهام برای خریدار
فروشنده ──sell──◀ کوین (خالص کارمزد) ؛ ست‌ها سوزانده شدند
resolve ──┬─ برندگان ── ۱:۱ روی سهام برنده
          ├─ LPها    ── reserves[win] تناسبی
          └─ heldFees ──▶ Treasury.depositFee (تمام آن)
voidMarket ─── همه ── سپردهٔ خودشان با کارمزد، مقیاس‌شده با صندوق
شرکت‌کننده ──redeem──◀ کوین   (فقط سهم خودش، یک‌بار، تا claimDeadline())
ADMIN ──sweepUnclaimed بعد از claimDeadline()──▶ کل باقیماندهٔ موجودی ──▶ Treasury
```

## تحلیل امنیتی

| حوزه | نتیجه |
| --- | --- |
| Reentrancy | **مشکلی دیده نشد** — قفل storage + CEI در همهٔ مسیرهای پولی |
| توانگری | **ناوردا اعمال می‌شود** — تست‌های fuzz/invariant آن را assert می‌کنند |
| گرد کردن | خرید floor سهام، فروش ceil ورودی، بازگشت وجه در void floor — استخر با گرد شدن تخلیه نمی‌شود |
| توانگری در void | **کران‌دار** — بازگشت وجه برابر `deposit · totalSets / _totalDeposited` است و `_totalDeposited ≥ totalSets`، پس مجموع پرداخت‌ها حداکثر به اندازهٔ صندوق است؛ خبری از «هرکه زودتر رسید» نیست |
| حل زودهنگام | **ملاحظهٔ طراحی/اعتماد** — resolve قبل از lockTime ممکن است؛ صحت به ADMIN_ROLE وابسته است |
| MEV | buy/sell مرز دارند؛ addFunding بی‌deadline؛ removeFunding هیچ‌مرزی ندارد — شکاف مستند |
| DoS | حلقه‌ها ≤ 16 خروجی؛ شکست send فقط payout خودِ فراخواننده را تحت تأثیر قرار می‌دهد |

## اطلاعات دیپلوی

فقط به‌صورت کلون دیپلوی می‌شود (implementation لخت توسط `ignition/modules/forecast.ts`).
آدرس کلون‌ها در رویداد `MarketCreated` منتشر می‌شود. آدرس‌های مشخص: Not found in repository.

## راهنمای یکپارچه‌سازی

قبل از معامله با `calcBuy`/`calcSell` کوت بگیرید و min*/deadline واقع‌بینانه بدهید.
پس از تعیین‌تکلیف `redeem()` بزنید — تنها مسیر پرداخت است و `pendingPayout(account)`
می‌گوید چقدر می‌پردازد. بعد از void آن عدد از `depositOf(account)` می‌آید، نه از موجودی سهام.
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
| `sweepUnclaimed()` | external | nonpayable | Controller | باقیمانده ← خزانه، بعد از پنجرهٔ بازخرید |
| viewها | external | view | همه | قیمت/رزرو/کوت/نام |
