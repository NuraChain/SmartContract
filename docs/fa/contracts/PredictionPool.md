# PredictionPool

> نسخهٔ انگلیسی: [../../contracts/PredictionPool.md](../../contracts/PredictionPool.md)

## نمای کلی قرارداد

| ویژگی | مقدار |
| --- | --- |
| نام قرارداد | `PredictionPool` |
| فایل سولیدیتی | `contracts/forecast/PredictionPool.sol` |
| نسخهٔ سولیدیتی | `0.8.24` دقیق (viaIR، cancun) |
| نوع قرارداد | بازار پیش‌بینی پاری‌موچل؛ به‌صورت **کلون EIP-1167** با [`createMarket2`](PredictionFactory.md) دیپلوی و یک‌بار مقداردهی می‌شود |
| هدف | شرکت‌کنندگان تا `lockTime` مستقیماً روی یک خروجی شرط می‌بندند؛ بعد ادمین برنده را اعلام می‌کند، کارمزد خانه یک‌بار از کل استخر کسر و باقیمانده به نسبت سهام پشتیبانان خروجی برنده تقسیم می‌شود |

```text
payout(user) = (totalPool − fee) · stakeOnWinner(user) / totalStakedOnWinner
```

معامله ندارد، سهام ضرب نمی‌شود، LP وجود ندارد. کل کارمزد به خزانه می‌رود.

## متغیرهای State

| متغیر | هدف |
| --- | --- |
| `MAX_OUTCOMES = 16` | سقف حلقه‌ها (از جمله حلقهٔ بازگشت وجه در claim). |
| `MAX_FEE_BPS = 1000` | کارمزد خانه ≤ ۱۰٪. |
| `CLAIM_WINDOW = 365 days` | مهلت برداشت برندگان پس از تعیین‌تکلیف بازار. |
| `AUTO_DISTRIBUTE_BATCH = 20` | تعداد پرداخت‌هایی که داخل خودِ تراکنش تعیین‌تکلیف push می‌شود. |
| `PUSH_GAS = 50_000` (private) | گسی که به هر پرداختِ push‌شده داده می‌شود. |
| `controller/treasury/status/متادیتا/creator/timestamps/feeBps` | همان شکل PredictionMarket. |
| `totalPool` | مجموع شرط‌های همهٔ خروجی‌ها. |
| `_distributable` (private) | استخر منهای کارمزد؛ قابل تقسیم بین برندگان. |
| `endedAt` | زمان تعیین‌تکلیف؛ تا وقتی بازار زنده است صفر. مبدأ پنجرهٔ برداشت. |
| `_winningOutcome` (private) | فقط وقتی Resolved معنی‌دار. |
| `_stakedFor` (private) | کلید: خروجی ← جمع شرط روی آن. |
| `_stakeOf` (private) | کلیدها: حساب ← خروجی ← شرط آن حساب. |
| `_claimed` (private) | فلگ یک‌بارِ پرداخت هر حساب — هم push آن را می‌گذارد هم pull. |
| `_participants` (private) | هر حسابی که تا حالا شرط بسته، به ترتیب اولین شرط؛ توزیع همین فهرست را می‌پیماید. |
| `_totalStakeOf` (private) | شرط هر حساب روی همهٔ خروجی‌ها؛ هم مبلغ بازگشت void است و هم تستِ «اولین شرط» که فهرست را بی‌تکرار نگه می‌دارد. |
| `_cursor` / `_credited` (private) | جای رسیدنِ push در فهرست؛ و پرداخت‌هایی که تحویل نشد و منتظر برداشت با `claim` مانده‌اند. |
| `categoryId` / `autoDistribute` | دستهٔ بازار در رجیستری کارخانه؛ و اینکه تعیین‌تکلیف خودش پرداخت‌ها را push بکند یا نه — **تا وقتی ادمین روشنش نکند خاموش است.** |
| `_entered` (private) | قفل reentrancy مبتنی بر storage. |

## رویدادها

`BetPlaced(market, better, outcome, amount)` هنگام شرط موفق؛ ‏`RewardClaimed` هنگام
claim موفق یا پرداختِ push‌شده؛ ‏`UnclaimedSwept(market, treasury, amount)` هنگام جاروی
باقیمانده — جدا از `FeeCollected` ثبت می‌شود تا باقیمانده با درآمد خانه اشتباه گرفته نشود؛
`PayoutDeferred(market, account, amount)` وقتی پرداختِ push‌شده تحویل نشد،
`DistributionAdvanced(market, cursor, total, amount)` در هر دستهٔ توزیع،
`AutoDistributeSet(market, enabled)`؛ و رویدادهای چرخهٔ حیات مشترک.

## خطاهای متمایز

| خطا | شرط | مسیر |
| --- | --- | --- |
| `LockNotReached()` | تلاش برای حل وقتی `block.timestamp < lockTime` | ‏`resolve`. **عمداً سخت‌گیرانه‌تر از CPMM:** هر شرط دیرهنگام پرداخت همه را عوض می‌کرد |
| `NothingToClaim()` | قبلاً claim شده؛ صفر شرط روی برنده؛ جمع صفر؛ غیرپایانی | `claim` |
| `ClaimWindowOpen()` | جارو پیش از `endedAt + CLAIM_WINDOW` | `sweepUnclaimed` |
| `ClaimWindowClosed()` | برداشت در/پس از `endedAt + CLAIM_WINDOW` | `claim` |

بقیهٔ خطاها مشترک با [PredictionMarket](PredictionMarket.md).

## توابع

### طبقه‌بندی

- **کاربر / مالی:** ‏`bet`, `claim`
- **کیپرِ بدون مجوز:** ‏`distribute`
- **مدیریتی (controller):** ‏`pause`, `unpause`, `close`, `resolve`, `voidMarket`,
  `setTreasury`, `setAutoDistribute`, `sweepUnclaimed`, `initialize`
- **View:** ‏`winningOutcome`, `claimDeadline`, `distributionProgress`, `pendingPayout`,
  `participantCount`, `stakedFor`, `myStake`, `distributableAmount`, `previewPayout`,
  `impliedOdds`, `outcomeName`, `totalPool`

---

### initialize

غیر-payable (استخر seed نمی‌خواهد). اعتبارسنجی آدرس‌ها، تعداد خروجی ۲..۱۶، کارمزد و
زمان‌بندی؛ ‏`_entered=1`. توسط کارخانه در `createMarket2` فراخوانی می‌شود.

---

### bet

```solidity
function bet(uint256 outcomeIndex) external payable nonReentrant returns (uint256 staked);
```

**دسترسی:** همه تا وقتی Open **و** قبل از lockTime.
جریان: چک وضعیت → چک قفل → چک اندیس → `staked = msg.value ≠ 0` → فقط effects:
به‌روزرسانی `_stakeOf`، ‏`_stakedFor`، ‏`totalPool` → صدور `BetPlaced`.
هیچ تماس خارجی‌ای در کار نیست.

---

### resolve

```solidity
function resolve(uint256 winningOutcome_) external onlyController nonReentrant;
```

اعلام برنده **فقط پس از lockTime**. جریان: چک پایان‌نیافته → چک lock (`LockNotReached`) →
چک اندیس → ثبت برنده و Resolved → محاسبهٔ `fee = pool·feeBps/BPS` (floor) و
`_distributable = pool - fee` → ارسال fee به خزانه → صدور `MarketResolved`.

**نکتهٔ امنیتی:** اگر ادمین خروجیِ **بدون هیچ شرطی** را اعلام کند، همهٔ `claim()`های آینده
قبل از رسیدن به تقسیم در چک `mine == 0` revert می‌شوند — جایزه برای همیشه غیرقابل برداشت
می‌شود (مسیر خطای ادمین؛ وجوه منجمد می‌شوند نه دزدیده). ادمین باید خروجیِ دارای شرط را
اعلام کند.

---

### claim

```solidity
function claim() external nonReentrant returns (uint256 payout);
```

پرداخت pull-payment یک‌باره:

- **Resolved:** ‏`payout = شرطِ_من_روی(برنده) · _distributable / stakedFor(برنده)`
  (floor؛ گردِ ریز در قرارداد می‌ماند). صفر شرط روی برنده ⇒ `NothingToClaim`.
- **Voided:** جمع شرط‌های فراخواننده روی همهٔ خروجی‌ها (بازگشت دقیق و بی‌کارمزد).
- غیر از این دو ⇒ `MarketNotResolved`.

ابتدا effects (`_claimed = true`) سپس ارسال. پرداخت دوباره با ساختار ناممکن است — همان
فلگی است که push هم می‌گذارد. اگر اعتباری از یک push تحویل‌نشده منتظر باشد، اول و کامل
پرداخت می‌شود. برداشت در `claimDeadline()` با `ClaimWindowClosed` بسته می‌شود (به
`sweepUnclaimed` نگاه کنید).

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
`CLAIM_WINDOW` به طول یک سال از همان‌جا شروع می‌شود؛ در این مدت `claim` دقیقاً مثل قبل
کار می‌کند و چیزی از استخر بیرون نمی‌رود. در `claimDeadline()` ورق برمی‌گردد: `claim`
برای همه `ClaimWindowClosed` می‌دهد و ادمین می‌تواند باقیمانده را جمع کند.

- تا وقتی `endedAt == 0` است `MarketNotResolved` می‌دهد (استخر زنده هرگز جارو نمی‌شود).
- پیش از مهلت `ClaimWindowOpen`، و وقتی چیزی نمانده باشد `ZeroAmount`.
- کل موجودی را جارو می‌کند: سهم برندگانی که سراغش نیامدند، بازگشت‌های void که کسی
  برنداشت، و گردِ زیرواحدی که هر پرداخت تناسبی جا می‌گذارد. `_distributable` را صفر
  می‌کند، مبلغ را با `IPredictionTreasury.depositFee` به خزانه می‌فرستد و
  `UnclaimedSwept` را emit می‌کند.

همین مسیر تنها موردِ مستندِ خطای ادمین را هم از بن‌بست درمی‌آورد: بازاری که به خروجیِ
بدون شرط حل شده باشد، دیگر استخرش برای همیشه حبس نمی‌ماند.

---

### Viewها

```solidity
winningOutcome()      // خارج از Resolved revert
stakedFor(i)          // جمع شرط روی خروجی i
myStake(i)            // شرط فراخواننده روی i
distributableAmount() // جایزه پس از کارمزد (پیش از resolve صفر)
previewPayout(i)      // فرضی: اگر همین حالا به i حل شود، پرداخت من چقدر است؟
impliedOdds(i)        // سهم شرط خروجی از کل استخر، WAD (1e18)
claimDeadline()       // endedAt + CLAIM_WINDOW؛ تا وقتی بازار زنده است صفر
endedAt()             // زمان تعیین‌تکلیف؛ تا وقتی بازار زنده است صفر
distributionProgress()// (cursor, total) پیمایش توزیع خودکار
pendingPayout(a)      // اعتبار منتظر، وگرنه سهم آن حساب
participantCount()    // طول فهرست توزیع
autoDistribute()      // آیا تعیین‌تکلیف خودش پرداخت‌ها را push می‌کند
categoryId()          // شناسهٔ دسته در رجیستری کارخانه
```

`previewPayout`/`impliedOdds` اطلاعاتی‌اند — استخر واقعی تا lockTime بزرگ می‌شود.

## کنترل دسترسی

| تابع | دسترسی |
| --- | --- |
| `bet` | همه (Open، قبل از lock) |
| `claim` | ذی‌نفعان، هر کس یک‌بار، تا `claimDeadline()` |
| `distribute` | **همه** — فقط وثیقهٔ تعیین‌تکلیف‌شده را به حساب‌هایی می‌برد که از قبل مستحق‌اند |
| `sweepUnclaimed` | controller (کارخانه)، فقط بعد از `claimDeadline()` |
| چرخهٔ حیات + initialize | controller (کارخانه) |

## جریان مالی

```text
شرط‌بندان ──bet{value}──▶ totalPool (حسابداری به تفکیک خروجی)
ADMIN ──resolve(w) بعد از lock──▶ fee ──▶ Treasury
                                  └─ distributable ──▶ تناسبی به برندگان
   (با autoDistribute روشن) ──▶ دستهٔ اول همان‌جا به کیف پول‌شان push می‌شود
هرکسی ──distribute(limit)──▶ همان فهرست را می‌پیماید، روشن باشد یا خاموش
تحویل‌نشده ──▶ اعتبار ──▶ برنده ──claim──◀ کوین          (تا claimDeadline())
مسیر void: voidMarket ← هر شرط‌بند دقیقاً شرط خودش را پس می‌گیرد، بی‌کارمزد
بعد از claimDeadline(): ADMIN ──sweepUnclaimed──▶ کل باقیماندهٔ موجودی ──▶ Treasury
```

## تحلیل امنیتی

| حوزه | نتیجه |
| --- | --- |
| Reentrancy | **مشکلی دیده نشد** — CEI کامل + قفل روی resolve/bet/claim؛ bet تماس خارجی ندارد |
| ادعای دوباره | ناممکن — فلگ یک‌باره قبل از انتقال نوشته می‌شود |
| دستکاری با حل زودهنگام | **نسبت به CPMM بسته شده** — ‏`LockNotReached` |
| گرد کردن | floor به نفع استخر؛ ریزِ زیر واحد در قرارداد می‌ماند |
| خطای ادمین | **تا حدی مهار شد** — اعلام خروجیِ بدون شرط هنوز claims را می‌شکند، اما استخر دیگر برای همیشه حبس نمی‌شود: یک سال بعد `sweepUnclaimed` آن را به خزانه برمی‌گرداند. در غیر این صورت حل متمرکز است |
| وجوه برداشت‌نشده | کران‌دار — بازار تعیین‌تکلیف‌شده تا ابد کوین نگه نمی‌دارد؛ پس از یک سال پنجرهٔ برداشت، باقیمانده برای ادمین قابل جمع‌آوری است و چون بریدگی روی خودِ مهلت است نه تراکنش جارو، برای همهٔ برداشت‌کنندگان یکسان است |
| DoS | حلقه‌ها ≤ 16 و در `distribute` به `limit` فراخواننده محدود است؛ push شکست‌خورده به اعتبار تبدیل می‌شود نه تکرار، پس هیچ گیرنده‌ای صف را نمی‌خواباند |

## راهنمای یکپارچه‌سازی

برای UI از `impliedOdds(i)`، ‏`myStake(i)` و `previewPayout(i)` استفاده کنید.
جریان: منتظر `Open && timestamp < lockTime` → ‏`bet{value}(i)` → گوش به
`MarketResolved(market, w)` → برندگان `claim()` بزنند.
خطاهای رایج: ‏`TradingLocked`، ‏`MarketNotOpen`، ‏`NothingToClaim`.

## مرجع سریع توابع

| تابع | Visibility | Mutability | دسترسی | هدف |
| --- | --- | --- | --- | --- |
| `initialize(...)` | external | nonpayable | کارخانه، یک‌بار | راه‌اندازی کلون |
| `bet(outcomeIndex)` | external | payable | عموم (Open,<lock) | شرط بستن کوین بومی |
| `claim()` | external | nonpayable | ذی‌نفعان | پرداخت برنده یا بازگشت void، یک‌بار |
| `pause/unpause/close/voidMarket/setTreasury` | external | nonpayable | Controller | چرخهٔ حیات |
| `resolve(w)` | external | nonpayable | Controller | اعلام برنده بعد از lock؛ کسر کارمزد |
| `setAutoDistribute(bool)` | external | nonpayable | Controller | روشن/خاموش کردن push هنگام تعیین‌تکلیف |
| `distribute(limit)` | external | nonpayable | **همه** | پرداخت به حداکثر `limit` شرط‌بند بعدی |
| `sweepUnclaimed()` | external | nonpayable | Controller | باقیمانده ← خزانه، بعد از پنجرهٔ برداشت |
| viewها | external | view | همه | ضرایب/شرط‌ها/پیش‌نمایش |
