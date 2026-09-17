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
| `AUTO_DISTRIBUTE_BATCH` | `uint256` | public | constant | ‏20؛ تعداد پرداخت‌هایی که داخل خودِ تراکنش تعیین‌تکلیف push می‌شود. |
| `PUSH_GAS` | `uint256` | private | constant | ‏50_000؛ گسی که به هر پرداختِ push‌شده داده می‌شود. |
| `controller` / `treasury` / `status` | address/address/enum | public | mutable | کارخانه، خزانه، وضعیت چرخهٔ حیات. |
| متادیتا + `creator` + سه timestamp | string/address/uint64 | public | set-once | در initialize نوشته می‌شوند؛ معامله نیازمند `block.timestamp < lockTime`. |
| `categoryId` | uint32 | public | set-once | دستهٔ بازار در [رجیستری کارخانه](PredictionFactory.md#رجیستری-دسته‌ها)؛ خودِ بازار هیچ نامی برای دسته ذخیره نمی‌کند. |
| `autoDistribute` | bool | public | mutable | آیا تعیین‌تکلیف خودش پرداخت‌ها را push می‌کند. **تا وقتی ادمین روشنش نکند خاموش است.** هرگز جلوی پول را نمی‌گیرد. |
| `feeBps` | uint16 | public | set-once | کارمزد کل معامله؛ تمام آن به خزانه می‌رود. |
| `outcomeCount` | uint256 | public | set-once | تعداد خروجی‌ها n. |
| `_outcomeNames` / `_reserves` | string[] / uint256[] | private | set-once / mutable | نام‌ها / رزرو مجازی FPMM به wei. |
| `totalSets` | uint256 | public | mutable | وثیقهٔ پشت ست‌های کامل؛ برابر موجودی بومی قرارداد. |
| `endedAt` | uint64 | public | در resolve/void ثبت | زمان تعیین‌تکلیف؛ تا وقتی بازار زنده است صفر. مبدأ پنجرهٔ بازخرید. |
| `_holders` / `_listed` (private) | address[] / mapping | فقط افزودنی | هر حسابی که تا حالا توکنی از این بازار گرفته، به ترتیب اولین دریافت؛ توزیع همین فهرست را می‌پیماید. موجودی صفر هنگام پرداخت رد می‌شود. |
| `_cursor` / `_credited` (private) | uint256 / mapping | mutable | جای رسیدنِ push در فهرست؛ و پرداخت‌هایی که تحویل نشد و منتظر برداشت با `redeem` مانده‌اند. |
| `_lpSupplyAtEnd` / `_lpPoolAtEnd` (private) | uint256 | در تعیین‌تکلیف ثبت | عرضهٔ LP و وثیقه‌ای که مجموعاً مال LPهاست (‏`reserves[win]` در resolve، میانگین رزروها در void). اسنپ‌شات گرفته می‌شود چون سوزاندن سهام LP حین پیمایش عرضهٔ زنده را جابه‌جا می‌کند. |
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
Resolved/Voided`، ‏`UnclaimedSwept(market, treasury, amount)` هنگام جاروی باقیمانده،
`PayoutDeferred(market, account, amount)` وقتی پرداختِ push‌شده تحویل نشد و به اعتبار
تبدیل شد، ‏`DistributionAdvanced(market, cursor, total, amount)` در هر دستهٔ توزیع، و
`AutoDistributeSet(market, enabled)`. جزئیات در فایل انگلیسی همین سند.

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
- **کیپرِ بدون مجوز:** ‏`distribute`
- **مدیریتی (فقط کارخانه):** ‏`pause`, `unpause`, `close`, `resolve`, `voidMarket`,
  `setTreasury`, `setAutoDistribute`, `sweepUnclaimed`, `initialize`
- **View:** ‏`winningOutcome`, `claimDeadline`, `distributionProgress`, `pendingPayout`,
  `holderCount`, `getReserves`, `getPrices`, `calcBuy`, `calcSell`, `outcomeName`,
  `totalSets` (+ سطح ERC-1155)
- **Private:** ‏`_requireTradable`, `_requireNotEnded`, `_requireClaimWindowOpen`,
  `_snapshotLp`, `_payoutOf`, `_settleAccount`, `_pushPayouts`, `_update`, `_sendNative`

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
کارمزد با `FeeMath` (fee و invest = amountIn − fee) → محاسبه با
`MarketMath.calcBuyShares` → چک slippage → effects: همهٔ رزروها += invest؛ رزرو
خریداری‌شده -= sharesOut؛ totalSets += invest؛ ضرب سهام → تعامل: ارسال کل کارمزد به خزانه.
**امنیت:** محافظت MEV با minSharesOut+deadline؛ CEI؛ کارمزد روی ورودی واقعی.

---

### sell

```solidity
function sell(uint256 outcomeIndex, uint256 returnAmount, uint256 maxSharesIn, uint256 deadline)
    external nonReentrant returns (uint256 sharesIn);
```

معکوس خرید: سوزاندن `sharesIn` توکن خروجی و دریافت `returnAmount` خالص.
‏`grossFromNet` کارمزد را به بالا گرد می‌کند. effects: burn؛ رزرو سایر خروجی‌ها -= gross؛
رزرو خروجی فروش‌شده += sharesIn − gross؛ totalSets -= gross. سپس کل کارمزد به خزانه و
پرداخت به فروشنده. مرز slippage برعکس است: بیشینهٔ توکنی که می‌دهید.

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

مسیر **pull**، و مسیر پیش‌فرض: بازار به‌درخواست پرداخت می‌کند، مگر ادمین push هنگام
تعیین‌تکلیف را روشن کرده باشد (پایین‌تر). در آن حالت هم این همان راهی است که حساب وقتی
push به او نرسیده استفاده می‌کند — یا هر وقت خودش ترجیح بدهد سهمش را بردارد.

- **اعتبارِ منتظر** (push تلاش کرده و انتقال شکست خورده) اول و به‌طور کامل پرداخت می‌شود.
- **Resolved:** سوزاندن کل موجودی توکن برنده و پرداخت ۱:۱، به‌علاوهٔ سهم تناسبی او از
  استخر LP (‏`lpBalance · _lpPoolAtEnd / _lpSupplyAtEnd`) با سوزاندن سهام LP‌اش.
- **Voided:** سوزاندن موجودی‌ها در همهٔ خروجی‌ها و پرداخت `floor(Σ balances / n)`
  — دارایی‌ها را ست کامل کسری فرض می‌کند — به‌علاوهٔ همان سهم LP.

گرد شدن به نفع استخر؛ payout به totalSets گیر می‌کند. همین سوزاندن است که پرداخت را
یک‌باره می‌کند: فراخوانی دوم موجودی صفر می‌بیند و `NothingToClaim` می‌دهد. یک سال پس از
تعیین‌تکلیف بازار هم `ClaimWindowClosed` می‌دهد (به `sweepUnclaimed` نگاه کنید).

---

### distribute

```solidity
function distribute(uint256 limit) external nonReentrant returns (uint256 paid);
```

مسیر **push**: شرکت‌کننده‌ها بدون اینکه کاری بکنند پول‌شان را می‌گیرند.

‏`distribute` **بدون مجوز** است: کیپر، فرانت‌اند، یا شرکت‌کننده‌ای که عجله دارد، هر سه
می‌توانند صدایش بزنند — و روی بازاری که با پیش‌فرض‌هایش رها شده، تنها چیزی است که بدون
درخواستِ خودِ شخص به او پول می‌دهد.

اگر `autoDistribute` روشن شود، ‏`resolve` و `voidMarket` هم همین را برای
`AUTO_DISTRIBUTE_BATCH` حساب، داخل همان تراکنشِ تعیین‌تکلیف صدا می‌زنند؛ پس بازاری با
شرکت‌کنندهٔ کم، همان لحظه که ادمین تعیین‌تکلیفش می‌کند خالی می‌شود و `distribute` بقیه را
ادامه می‌دهد.

هر حساب پیش از انتقالش پرداخت‌شده علامت می‌خورد و با `PUSH_GAS` گس پرداخت می‌شود. انتقالی
که شکست بخورد کل دسته را revert نمی‌کند: مبلغ به اعتبار (`_credited`) تبدیل می‌شود،
`PayoutDeferred` ثبت می‌شود و پیمایش ادامه پیدا می‌کند. بنابراین یک گیرندهٔ خصمانه
نمی‌تواند صف پشت سرش را بخواباند.

---

### setAutoDistribute

```solidity
function setAutoDistribute(bool enabled) external onlyController;
```

‏push هنگام تعیین‌تکلیف را روشن یا خاموش می‌کند. **بازارها با خاموش شروع می‌شوند**، پس این
همان opt-in است. یک کلید راحتی است، نه گیتِ دسترسی: با خاموش‌بودنش هم `distribute` برای
همه باز است و هم شرکت‌کننده می‌تواند سهم خودش را بردارد؛ فقط تعیین‌تکلیف خودبه‌خود شروع
به پرداخت نمی‌کند. ‏`AutoDistributeSet` را emit می‌کند.

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
موتور استخر این را بسته است)؛ ‏`voidMarket()` حالت بازگشت وجه؛ ‏`setTreasury`؛
`setAutoDistribute(bool)`؛ ‏`sweepUnclaimed()` انتقال باقیمانده به خزانه، فقط بعد از
`endedAt + CLAIM_WINDOW`.

‏`removeFunding` دیگر بعد از تعیین‌تکلیف کار نمی‌کند (`MarketAlreadyEnded`): از آن به بعد
سهام LP را خودِ توزیع به‌صورت وثیقه پرداخت می‌کند، و تبدیلش به توکن خروجی یعنی پرداخت
دوبارهٔ همان رزروها.

---

### Viewها

`winningOutcome()` (خارج از Resolved revert)، ‏`getReserves()`، ‏`getPrices()`
(قیمت‌های WAD با مجموع ≈1e18)، ‏`calcBuy(i,amountIn)` و `calcSell(i,returnAmount)`
(کوت استاتیک)، ‏`outcomeName(i)`، ‏`totalSets()`، ‏`endedAt()`، ‏`claimDeadline()`
(برابر `endedAt + CLAIM_WINDOW`، و تا وقتی بازار زنده است صفر)، ‏`distributionProgress()`
(‏cursor و total پیمایش توزیع)، ‏`pendingPayout(account)` (اعتبار منتظر، وگرنه سهم آن
حساب)، ‏`holderCount()`، ‏`autoDistribute()` و `categoryId()`.
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
         ├─ fee ──▶ Treasury.depositFee (تمام آن)
         └─ invest ──▶ رزروها ⇄ ضرب سهام برای خریدار
فروشنده ──sell──◀ کوین (خالص کارمزد) ؛ ست‌ها سوزانده شدند
تعیین‌تکلیف ──┬─ برندگان ── ۱:۱ روی سهام برنده
              └─ LPها    ── reserves[win] تناسبی
   (با autoDistribute روشن) ──▶ دستهٔ اول همان‌جا به کیف پول‌شان push می‌شود
هرکسی ──distribute(limit)──▶ همان فهرست را می‌پیماید، روشن باشد یا خاموش
تحویل‌نشده ──▶ اعتبار ──▶ برنده ──redeem──◀ کوین      (تا claimDeadline())
ADMIN ──sweepUnclaimed بعد از claimDeadline()──▶ کل باقیماندهٔ موجودی ──▶ Treasury
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
| `setAutoDistribute(bool)` | external | nonpayable | Controller | روشن/خاموش کردن push هنگام تعیین‌تکلیف |
| `distribute(limit)` | external | nonpayable | **همه** | پرداخت به حداکثر `limit` دارندهٔ بعدی |
| `sweepUnclaimed()` | external | nonpayable | Controller | باقیمانده ← خزانه، بعد از پنجرهٔ بازخرید |
| viewها | external | view | همه | قیمت/رزرو/کوت/نام |
