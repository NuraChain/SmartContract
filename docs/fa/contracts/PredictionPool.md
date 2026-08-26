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

معامله ندارد، سهام ضرب نمی‌شود، LP وجود ندارد. ‏`protocolFeeShareBps` نادیده گرفته
می‌شود: کل کارمزد به خزانه می‌رود.

## متغیرهای State

| متغیر | هدف |
| --- | --- |
| `MAX_OUTCOMES = 16` | سقف حلقه‌ها (از جمله حلقهٔ بازگشت وجه در claim). |
| `MAX_FEE_BPS = 1000` | کارمزد خانه ≤ ۱۰٪. |
| `controller/treasury/status/متادیتا/creator/timestamps/feeBps` | همان شکل PredictionMarket؛ ‏`protocolFeeShareBps` فقط برای هم‌شکلی ذخیره و بلااستفاده. |
| `totalPool` | مجموع شرط‌های همهٔ خروجی‌ها. |
| `_distributable` (private) | استخر منهای کارمزد؛ قابل تقسیم بین برندگان. |
| `_winningOutcome` (private) | فقط وقتی Resolved معنی‌دار. |
| `_stakedFor` (private) | کلید: خروجی ← جمع شرط روی آن. |
| `_stakeOf` (private) | کلیدها: حساب ← خروجی ← شرط آن حساب. |
| `_claimed` (private) | فلگ یک‌بارِ برداشت هر حساب. |
| `_entered` (private) | قفل reentrancy مبتنی بر storage. |

## رویدادها

`BetPlaced(market, better, outcome, amount)` هنگام شرط موفق؛ ‏`RewardClaimed` هنگام
claim موفق؛ رویدادهای چرخهٔ حیات مشترک.

## خطاهای متمایز

| خطا | شرط | مسیر |
| --- | --- | --- |
| `LockNotReached()` | تلاش برای حل وقتی `block.timestamp < lockTime` | ‏`resolve`. **عمداً سخت‌گیرانه‌تر از CPMM:** هر شرط دیرهنگام پرداخت همه را عوض می‌کرد |
| `NothingToClaim()` | قبلاً claim شده؛ صفر شرط روی برنده؛ جمع صفر؛ غیرپایانی | `claim` |

بقیهٔ خطاها مشترک با [PredictionMarket](PredictionMarket.md).

## توابع

### طبقه‌بندی

- **کاربر / مالی:** ‏`bet`, `claim`
- **مدیریتی (controller):** ‏`pause`, `unpause`, `close`, `resolve`, `voidMarket`,
  `setTreasury`, `initialize`
- **View:** ‏`winningOutcome`, `stakedFor`, `myStake`, `distributableAmount`,
  `previewPayout`, `impliedOdds`, `outcomeName`, `totalPool`

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

ابتدا effects (`_claimed = true`) سپس ارسال. ادعای دوباره با ساختار ناممکن است.

---

### Viewها

```solidity
winningOutcome()      // خارج از Resolved revert
stakedFor(i)          // جمع شرط روی خروجی i
myStake(i)            // شرط فراخواننده روی i
distributableAmount() // جایزه پس از کارمزد (پیش از resolve صفر)
previewPayout(i)      // فرضی: اگر همین حالا به i حل شود، پرداخت من چقدر است؟
impliedOdds(i)        // سهم شرط خروجی از کل استخر، WAD (1e18)
```

`previewPayout`/`impliedOdds` اطلاعاتی‌اند — استخر واقعی تا lockTime بزرگ می‌شود.

## کنترل دسترسی

| تابع | دسترسی |
| --- | --- |
| `bet` | همه (Open، قبل از lock) |
| `claim` | ذی‌نفعان، هر کس یک‌بار |
| چرخهٔ حیات + initialize | controller (کارخانه) |

## جریان مالی

```text
شرط‌بندان ──bet{value}──▶ totalPool (حسابداری به تفکیک خروجی)
ADMIN ──resolve(w) بعد از lock──▶ fee ──▶ Treasury
                                  └─ distributable ──▶ claims تناسبی برندگان
مسیر void: voidMarket ← هر شرط‌بند دقیقاً شرط خودش را پس می‌گیرد، بی‌کارمزد
```

## تحلیل امنیتی

| حوزه | نتیجه |
| --- | --- |
| Reentrancy | **مشکلی دیده نشد** — CEI کامل + قفل روی resolve/bet/claim؛ bet تماس خارجی ندارد |
| ادعای دوباره | ناممکن — فلگ یک‌باره قبل از انتقال نوشته می‌شود |
| دستکاری با حل زودهنگام | **نسبت به CPMM بسته شده** — ‏`LockNotReached` |
| گرد کردن | floor به نفع استخر؛ ریزِ زیر واحد در قرارداد می‌ماند |
| خطای ادمین | **ریسک بالقوه** — اعلام خروجیِ بدون شرط، claims را برای همیشه می‌شکند؛ در غیر این صورت حل متمرکز است |
| DoS | حلقه‌ها ≤ 16؛ شکست send فقط ادعای خود فراخواننده را تحت تأثیر می‌گذارد |

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
| viewها | external | view | همه | ضرایب/شرط‌ها/پیش‌نمایش |
