# PredictionTreasury

> نسخهٔ انگلیسی: [../../contracts/PredictionTreasury.md](../../contracts/PredictionTreasury.md)

## نمای کلی قرارداد

| ویژگی | مقدار |
| --- | --- |
| نام قرارداد | `PredictionTreasury` |
| فایل سولیدیتی | `contracts/forecast/PredictionTreasury.sol` |
| نسخهٔ سولیدیتی | `0.8.24` دقیق |
| نوع قرارداد | مخزن کارمزد (standalone) |
| هدف | دریافت کارمزد پروتکل از بازارهای پیش‌بینی و برداشت آن‌ها توسط مالک به گیرندهٔ قابل‌تنظیم |
| ارتقاءپذیر / پروکسی | خیر / خیر |

بازارها سهم خود را با `depositFee{value}(market)` می‌فرستند؛ انتقال‌های ساده هم توسط
`receive()` پذیرفته و به فرستنده نسبت داده می‌شوند. حسابداری به تفکیک منبع نگه داشته
می‌شود.

## وراثت

```text
PredictionTreasury
├── IPredictionTreasury  -- اینترفیس پیاده‌سازی‌شده
├── Ownable2Step         -- واگذاری مالکیت دو مرحله‌ای
└── ReentrancyGuard      -- محافظ withdraw
```

## متغیرهای State

| متغیر | نوع | دید | هدف |
| --- | --- | --- | --- |
| `_feeRecipient` | address | private | مقصد برداشت‌ها. |
| `_totalCollected` | uint256 | private | کل کارمزدهای عمر (`totalCollected()`). |
| `_collectedFor` | mapping(address => uint256) | private | کلید: آدرس بازار ← کارمزد دریافتی از آن (`collectedFor(market)`). |

## Modifierها

| Modifier | استفاده در | اثر |
| --- | --- | --- |
| `onlyOwner` | withdraw، setFeeRecipient | مدیریت فقط مالک |
| `nonReentrant` | withdraw | بستن reentrancy حول پرداخت |

## رویدادها

| رویداد | پارامترها | Indexed | محل صدور |
| --- | --- | --- | --- |
| `FeeCollected` | `market, amount` | market | هر depositFee/receive؛ برای انتقال ساده market = msg.sender |
| `FeeWithdrawn` | `to, amount` | ندارد | withdraw موفق |
| `FeeRecipientChanged` | `recipient` | indexed | سازنده و setFeeRecipient |
| (ارثی) رویدادهای مالکیت | — | — | handover دومرحله‌ای |

## خطاها

`ZeroAddress` (گیرنده صفر)، ‏`ZeroAmount` (واریز/برداشت صفر)، ‏`InsufficientLiquidity`
(برداشت بیش از موجودی)، ‏`TransferFailed` (شکست call)، ‏`OwnableUnauthorizedAccount`
(غیرمالک).

## توابع

### depositFee

```solidity
function depositFee(address market) external payable;
```

ثبت `msg.value` به نام `market` و افزایش جمع‌ها + رویداد. **دسترسی:** همه (بازارها صدا
می‌زنند؛ باز بودن عمدی است). value صفر revert می‌شود.

### receive

انتقال‌های سادهٔ کوین بومی را می‌پذیرد و به msg.sender نسبت می‌دهد.

### withdraw

```solidity
function withdraw(uint256 amount) external onlyOwner nonReentrant;
```

ارسال amount به `_feeRecipient` با call سطح پایین. چک‌ها: مقدار > 0، موجودی کافی.
رویداد **قبل از** ارسال. **امنیت:** تخلیه فقط مالک؛ گیرنده خراب فقط revert می‌کند و وجه
می‌ماند.

### setFeeRecipient

```solidity
function setFeeRecipient(address recipient) external onlyOwner;
```

چک صفر + رویداد. مقدار اشتباه بعداً قابل اصلاح است (فقط مالک).

### Viewها

`feeRecipient()`, `totalCollected()`, `collectedFor(market)` + توابع مالکیت ارثی
(`owner`, `pendingOwner`, `transferOwnership`, `acceptOwnership`, `renounceOwnership`).

## کنترل دسترسی

| تابع | دسترسی |
| --- | --- |
| `depositFee`, `receive` | همه |
| `withdraw`, `setFeeRecipient` | مالک |
| تغییر مالکیت | دومرحله‌ای |

**اختیارات CRITICAL:**‏ `withdraw` تمام کارمزدها را جابه‌جا می‌کند. مالکیت دومرحله‌ای است.

## تحلیل امنیتی

- Reentrancy: قفل + ترتیب CEI.
- تمرکز: مالکِ واحد همه‌چیز را برمی‌گرداند — برای خزانه طبیعی است.
- Griefing: هر کس می‌تواند با receive کمک کند (صادقانه ثبت می‌شود)؛ آسیبی جز نویز حسابداری ندارد.
- غیر از این **مشکلی دیده نشد**؛ سطح حمله حداقلی است.

## اطلاعات دیپلوی

با `ignition/modules/forecast.ts` و `(admin, feeRecipient)` دیپلوی می‌شود؛ admin پیش‌فرض
دیپلوی‌کننده، feeRecipient پیش‌فرض همان ادمین و بعداً قابل اصلاح. آدرس: Not found in repository.

## راهنمای یکپارچه‌سازی

خواندن: `totalCollected()`, `collectedFor(market)` برای تحلیل درآمد.
گوش دهید به: `FeeCollected` (به تفکیک بازار) و `FeeWithdrawn`.

## مرجع سریع توابع

| تابع | Visibility | Mutability | دسترسی | هدف |
| --- | --- | --- | --- | --- |
| `depositFee(market)` | external | payable | همه | ثبت کارمزد از بازار |
| `receive()` | external | payable | همه | پذیرش انتقال ساده |
| `withdraw(amount)` | external | nonpayable | مالک | پرداخت به گیرنده |
| `setFeeRecipient(r)` | external | nonpayable | مالک | تغییر مقصد |
| viewها | external | view | همه | گزارش‌گیری |
