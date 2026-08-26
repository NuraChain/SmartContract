# PredictionFactory

> نسخهٔ انگلیسی: [../../contracts/PredictionFactory.md](../../contracts/PredictionFactory.md)

## نمای کلی قرارداد

| ویژگی | مقدار |
| --- | --- |
| نام قرارداد | `PredictionFactory` |
| فایل سولیدیتی | `contracts/forecast/PredictionFactory.sol` |
| نسخهٔ سولیدیتی | `0.8.24` دقیق (کامپایل با viaIR، cancun) |
| نوع قرارداد | کارخانهٔ کلون + اتاق کنترل ادمین + رجیستری |
| هدف | دیپلوی بازارهای پیش‌بینی به‌صورت کلون‌های ارزان EIP-1167 از دو پیاده‌سازی موتور، نگهداری رجیستری مرجع با سطل‌های وضعیت و صفحه‌بندی، و رلهٔ همهٔ اقدامات چرخهٔ حیات به کلون‌ها |
| ارتقاءپذیر / پروکسی | خودش نه؛ اما *می‌سازد* پروکسی‌های EIP-1167 از پیاده‌سازی‌های immutable |

دو مسیر ساخت:

- `createMarket` (payable) — کلونی از [`PredictionMarket`](PredictionMarket.md)
  (CPMM، سهام خروجی ERC-1155، معاملهٔ AMM). ارزش seed به نقدینگی اولیهٔ LP تبدیل می‌شود.
- `createMarket2` (غیر-payable) — کلونی از [`PredictionPool`](PredictionPool.md)
  (شرط‌بندی پاری‌موچل؛ بدون LP). الصاق ارزش عمداً رد می‌شود چون استخر به seed نیاز ندارد
  و ارزش الصاقی بازیابی‌ناپذیر می‌شد.

هر کلون به کارخانه به‌عنوان **controller** اعتماد دارد؛ فراخوانی‌های چرخهٔ حیات
(pause/close/resolve/void) از طریق کارخانه انجام می‌شود تا وضعیتِ رجیستری مرجع بماند.

## وراثت

```text
PredictionFactory
└── AccessControl    -- نقش‌های DEFAULT_ADMIN_ROLE + ADMIN_ROLE در سازنده به admin
```

از کتابخانه‌های OZ ‏`Clones` و `EnumerableSet` هم استفاده می‌کند.

## اینترفیس‌ها

| اینترفیس | تعامل |
| --- | --- |
| `IPredictionFactory` | سطح پیاده‌سازی‌شده. |
| `IPredictionMarket` | روی کلون‌های تازه: ‏`initialize(...)`؛ توابع رلهٔ چرخهٔ حیات (`pause/unpause/close/resolve/voidMarket/setTreasury`) امضای یکسان در هر دو موتور دارند. |

## متغیرهای State

| متغیر | نوع | دید | تغییرپذیری | هدف |
| --- | --- | --- | --- | --- |
| `ADMIN_ROLE` | `bytes32` | public | constant | نقش ساخت و مدیریت بازارها. |
| `BPS` | `uint16` | public | constant | مخرج بیس‌پوینت `1e4`. |
| `MAX_FEE_BPS` | `uint16` | public | constant | ‏`1000`؛ سقف کارمزد ۱۰٪ برای بازارهای جدید. |
| `marketImplementation` | `address` | public | **immutable** | پیاده‌سازی CPMM که `createMarket` کلون می‌کند. |
| `poolImplementation` | `address` | public | **immutable** | پیاده‌سازی پاری‌موچل که `createMarket2` کلون می‌کند. |
| `_treasury` | `address` | private | mutable | خزانه‌ای که به بازارهای جدید اعمال می‌شود. |
| `defaultFeeBps` | `uint16` | public | mutable | کارمزدی که وقتی پارامترها `feeBps == 0` بدهند به ارث می‌رسد؛ همین‌جا درصد کارمزد به نوع/دستهٔ بازار گره می‌خورد. |
| `defaultProtocolFeeShareBps` | `uint16` | public | mutable | سهم خزانه به همین شکل (فقط CPMM؛ استخرها نادیده می‌گیرند). |
| `_records` | `MarketRecord[]` | private | mutable | رجیستری بر اساس marketId. |
| `_kinds` | `mapping(uint256 => MarketKind)` | private | mutable | marketId ← نوع موتور (`Amm`=0 پیش‌فرض، ‏`Pool`=1). |
| `_byStatus` | `mapping(MarketStatus => EnumerableSet.UintSet)` | private | mutable | گذار O(1) وضعیت + فیلتر صفحه‌بندی‌شده. |

## Structs (از `PredictionTypes.sol`)

```text
MarketParams  (پارامترهای ساخت که به initializer کلون می‌رود)
├── title, description, category, imageURI : string   -- متادیتا
├── creator              : address  -- حسابی که به‌عنوان سازنده/LP اول ثبت می‌شود
├── lockTime             : uint64   -- پایان معامله/شرط‌بندی
├── resolveTime          : uint64   -- زمان هدف حل (اطلاعاتی)
├── feeBps               : uint16   -- کارمزد کل؛ صفر ⇒ پیش‌فرض کارخانه
├── protocolFeeShareBps  : uint16   -- سهم خزانه؛ صفر ⇒ پیش‌فرض
└── outcomeNames         : string[] -- بین ۲ تا ۱۶ نام؛ طول = تعداد خروجی‌ها

MarketRecord  (اسنپ‌شات رجیستری)
├── market      : address  -- آدرس کلون
├── creator     : address
├── title, category : string
├── status      : MarketStatus
├── createdAt, lockTime, resolveTime : uint64
└── outcomeCount: uint32
```

## Enumها (از `PredictionTypes.sol`)

```text
MarketKind : Amm(0)، Pool(1)

MarketStatus:
  Open     (0) -- معامله/نقدینگی فعال تا lockTime
  Paused   (1) -- توقف برگشت‌پذیر توسط ادمین
  Closed   (2) -- توقف دائمی، در انتظار حل
  Resolved (3) -- برنده اعلام شده؛ سهام برنده ۱:۱ بازخرید می‌شود
  Voided   (4) -- حل نامعتبر؛ مبنی بازگشت وجه
```

## Modifierها

| Modifier | شرط | جلوگیری از | استفاده در |
| --- | --- | --- | --- |
| `onlyRole(ADMIN_ROLE)` | دارنده بودن ADMIN_ROLE | ساخت/مدیریت غیرادمینی | همهٔ توابع مدیریتی |

## رویدادها

| رویداد | پارامترها | Indexed | محل صدور |
| --- | --- | --- | --- |
| `MarketCreated` | `marketId, market, creator, category, outcomeCount, initialFunding` | سه‌تای اول | `createMarket` (‏initialFunding = msg.value) یا `createMarket2` (۰) |
| `TreasuryUpdated` | `treasury` | indexed | `setTreasury` |
| `FeesUpdated` | `feeBps, protocolFeeShareBps` | ندارد | `setDefaultFees` |

رویدادهای معامله/چرخهٔ حیات را خود کلون‌ها صادر می‌کنند (اعلام مشترک در
`PredictionEvents.sol`)؛ ایندکسرها باید به آدرس کلون گوش دهند.

## خطاها

| خطا | شرط وقوع | مسیر |
| --- | --- | --- |
| `ZeroAddress()` | سازنده: admin/treasury/هر implementation صفر؛ ‏`setTreasury(0)` | سازنده، setTreasury |
| `InvalidFee()` | ‏`feeBps > MAX_FEE_BPS` یا share > BPS | سازنده، setDefaultFees |
| `AccessControlUnauthorizedAccount` (OZ) | نبود ADMIN_ROLE | همهٔ توابع محافظت‌شده |
| خطاهای اعتبارسنجی کلون | پارامترهای بد داخل `initialize` کلون رد می‌شود (`InvalidOutcomeCount`, `InvalidTiming`, ... ) | createMarket/createMarket2 (revert اتمیک کل تراکنش) |

## توابع

### طبقه‌بندی

- **مدیریتی:** ‏`createMarket`, `createMarket2`, `pauseMarket`, `unpauseMarket`,
  `closeMarket`, `voidMarket`, `setTreasury`, `repointTreasury`,
  `setDefaultFees`
- **مولتی‌سگ حل:** ‏confirmResolution (امضاکننده‌ها)، ‏setResolutionSigners (مالک)
- **View:** ‏marketCount, marketAt, marketAddress, marketKind, 	reasury, esolutionSigners, equiredConfirmations, confirmationCount, confirmationOf, isResolutionSigner,
  `marketsPaged`, `marketsByStatus`, `activeMarkets`, `closedMarkets`,
  `resolvedMarkets`, `countByStatus`
- **Private:** ‏`_setStatus`

---

### createMarket

```solidity
function createMarket(MarketParams calldata params)
    external payable onlyRole(ADMIN_ROLE) returns (uint256 marketId, address market);
```

**هدف:** دیپلوی کلون CPMM، مقداردهی با `msg.value` به‌عنوان نقدینگی اولیه و ثبت آن.

**جریان:** ۱. کپی پارامترها در memory و اعمال پیش‌فرض‌ها برای فیلدهای صفر. ۲.
`Clones.clone(marketImplementation)`. ۳. فراخوانی
`initialize{value: msg.value}(address(this), _treasury, effective)` (اعتبارسنجی ۲..۱۶
خروجی، ‏`now < lockTime ≤ resolveTime`، سقف کارمزدها؛ ضرب سهام LP برای `params.creator`).
۴. افزودن رکورد و ورود به سطل Open. ۵. صدور `MarketCreated`.

**امنیت:** مقداردهی اولیه در همان تراکنشِ کلون‌سازی است — هیچ پنجرهٔ frontrun روی
`initialize` وجود ندارد.

---

### createMarket2

```solidity
function createMarket2(MarketParams calldata params)
    external onlyRole(ADMIN_ROLE) returns (uint256 marketId, address market);
```

مانند `createMarket` اما: کلون `poolImplementation`؛ **payable نیست** (الصاق ارزش revert
می‌شود)؛ فقط پیش‌فرض `feeBps == 0` اعمال می‌شود؛ ‏`_kinds[marketId] = MarketKind.Pool`
ثبت می‌گردد. رویداد با `initialFunding = 0`.

---

### رله‌های چرخهٔ حیات

هرکدام `external onlyRole(ADMIN_ROLE)` است؛ تابع هم‌نام را روی کلون صدا می‌زند و سپس
سطل رجیستری را با `_setStatus` به‌روز می‌کند. اگر گذار غیرمجاز باشد اول خودِ کلون revert
می‌کند، پس رجیستری و کلون هرگز ناهماهنگ نمی‌شوند:

| تابع | فراخوانی کلون | گذار وضعیت |
| --- | --- | --- |
| `pauseMarket(id)` *(ADMIN_ROLE)* | `pause()` | Open ← Paused |
| `unpauseMarket(id)` *(ADMIN_ROLE)* | `unpause()` | Paused ← Open |
| `closeMarket(id)` *(ADMIN_ROLE)* | `close()` | ← Closed |
| `confirmResolution(id, winningOutcome)` *(امضاکننده)* | ثبت رای؛ در حد نصاب `resolve(winningOutcome)` را اجرا می‌کند | ← Resolved |
| `voidMarket(id)` *(ADMIN_ROLE)* | `voidMarket()` | ← Voided |

marketId خارج از محدوده panic اندیس آرایه می‌دهد.

### مولتی‌سگ حل (N از M)

حل بازار — تنها اقدامی که تعیین می‌کند چه کسی پول می‌گیرد — پشت مجموعهٔ امضاکنندهٔ منصوبِ
مالک قرار گرفته، نه یک کلید ادمین واحد:

- **راه‌اندازی:** سازنده ‏`initialSigners` (حداکثر ‏`MAX_SIGNERS = 10`، یکتا و غیرصفر) و
  ‏`requiredConfirmations` ‏(‏`1 ≤ n ≤ تعداد امضاکننده‌ها`) می‌گیرد. شکل توصیه‌شده برای
  production: **پنج امضاکننده با حد نصاب سه**. مالک هر دو را به‌صورت اتمیک با
  `setResolutionSigners(signers, required)` عوض می‌کند.
- **رأی دادن:** هر امضاکننده `confirmResolution(marketId, outcome)` می‌زند — در هر بازار
  یک رأی باز برای هر امضاکننده؛ تغییر رأی قبل از حد نصاب، شمارنده را جابه‌جا می‌کند
  (`ResolutionConfirmed` تعداد جاری را حمل می‌کند).
- **اجرا:** لحظه‌ای که یک خروجی به `_required` رأی متمایز برسد، همان تراکنش `resolve`
  کلون را اجرا می‌کند — کارمزد خانه برداشته و پرداخت برندگان باز می‌شود — رجیستری Resolved
  شده و رویداد `ResolutionExecuted` صادر می‌گردد.
- **گاردها:** غیرامضاکننده `NotSigner`؛ بازار پایان‌یافته `MarketAlreadyEnded`؛ خروجی ناموجود
  `InvalidOutcome`. رأی‌ها پاک نمی‌شوند ولی بازار پایانی هرگز دوباره حل نمی‌شود.
- **تعامل با موتورها:** کلون‌های استخر قبل از `lockTime` اجازهٔ حل ندارند (`LockNotReached`)
  — پس در بازارهای استخر، حد نصاب فقط پس از بسته شدن شرط‌بندی می‌تواند اجرا شود؛ کلون‌های
  CPMM چنین تأخیری ندارند.

---

### setTreasury / repointTreasury / setDefaultFees

- `setTreasury`: خزانهٔ بازارهای *آینده* را عوض می‌کند؛ چک صفر + رویداد.
- `repointTreasury`: ‏`setTreasury(_treasury)` را روی یک کلون موجود صدا می‌زند تا
  بازارهای فعلی هم از خزانهٔ فعلی کارخانه پیروی کنند. تک‌بازاری است (نه حلقه) تا گاس محدود بماند.
- `setDefaultFees`: اعتبارسنجی با `MAX_FEE_BPS`/`BPS`؛ فقط بازارهای بعدی که صفر بدهند.

---

### نمای رجیستری

| تابع | خروجی |
| --- | --- |
| `marketCount()` / `marketAt(id)` / `marketAddress(id)` | طول/رکورد/آدرس کلون |
| `marketKind(id)` | ‏`Amm` یا `Pool` |
| `treasury()` | `_treasury` فعلی |
| `marketsPaged(offset, limit)` | صفحهٔ رکوردها؛ offset ≥ total ⇒ آرایهٔ خالی |
| `marketsByStatus(status, offset, limit)` | صفحه بر اساس سطل وضعیت |
| `activeMarkets/closedMarkets/resolvedMarkets(offset, limit)` | wrapperهای راحت |
| `countByStatus(status)` | اندازهٔ سطل |

صفحه‌بندی `end` را به total گیر می‌دهد و جز سرریز offset+limit هرگز revert نمی‌شود.

---

### _setStatus (private)

جابه‌جایی marketId بین سطل‌ها و نوشتن وضعیت رکورد؛ وقتی prev == next بی‌اثر است.

## کنترل دسترسی

| تابع | نقش لازم | چه کسی |
| --- | --- | --- |
| همهٔ توابع ساخت/چرخهٔ حیات/پیکربندی | `ADMIN_ROLE` | ادمین‌ها (مدیریت نقش با DEFAULT_ADMIN_ROLE) |
| همهٔ viewها | ندارد | همه |

**اختیارات CRITICAL:** ساخت بازار (با انتخاب کارمزد تا ۱۰٪)، void کردن،`nتغییر خزانه و — فقط مالک — تعویض مجموعهٔ امضاکننده‌ها/حد نصاب حل.`nخودِ حل به حد نصاب N-از-M امضاکننده (مثلاً ۳ از ۵) نیاز دارد، نه یک کلید واحد؛`nتبانیِ یک حد نصاب همچنان فرض اعتماد است.

## جریان مالی

```text
ADMIN ──createMarket{value}──▶ initialize روی کلون (seed = سهام LP برای creator)
کاربران ──buy/sell/bet──▶ کلون ──سهم پروتکل/خانه──▶ Treasury
امضاکننده‌ها ×N ──confirmResolution(id,outcome)──▶ حد نصاب؟ ──▶ resolve کلون ──کارمزد──▶ Treasury
برندگان ──redeem()/claim()──◀ موجودی کلون
```

خود کارخانه فراتر از forward موقتی `msg.value` در createMarket وجه نگه نمی‌دارد.

## تحلیل امنیتی

- **مسابقهٔ مقداردهی:** وجود ندارد — clone + initialize اتمیک است؛ سازندهٔ پیاده‌سازی‌ها
  `_disableInitializers()` صدا می‌زند.
- **تمرکز:** حل به حد نصاب N-از-M نیاز دارد نه یک کلید واحد؛ اما تبانی حد نصاب یا تعویض مجموعه توسط مالک همچنان فرض‌های اعتمادند؛ بدون پنجرهٔ اختلاف یا اوراکل. فرض اعتمادِ
  مستند.
- **سازگاری رجیستری:** با ترتیب اجرا (اول state کلون، بعد `_setStatus`) تضمین می‌شود؛
  شکست رله هر دو را دست‌نخورده می‌گذارد.
- **مشکلی دیده نشد:** reentrancy، مسائل عددی، griefing کارمزد (سقف ۱۰٪).

## ارتقاءپذیری

کارخانه و هر دو پیاده‌سازی پس از دیپلوی immutable هستند. «ارتقاء» موتور یعنی پیاده‌سازی +
کارخانهٔ جدید؛ کلون‌های موجود برای همیشه به controller خود اشاره می‌کنند.

## اطلاعات دیپلوی

- شبکه: Nurachain (1020). آدرس: Not found in repository.
- دیپلوی: `npm run deploy:nurachain:forecast` ← `ignition/modules/forecast.ts`
  (خزانه، هر دو پیاده‌سازی به‌صورت لخت — سازنده `_disableInitializers()` — سپس Factory؛
  admin پیش‌فرض دیپلوی‌کننده است و هر دو نقش را می‌گیرد).

## راهنمای یکپارچه‌سازی

خواندن: `activeMarkets`, `marketsPaged`, `marketAt`, `marketKind`.
جریان ادمین (مثلاً از پنل ادمین وب): ‏`createMarket2` برای بازارهای استخر → کاربران روی
کلون `bet` می‌زنند → بعد از lockTime امضاکننده‌ها `confirmResolution(id, outcome)` می‌زنند تا حد نصاب تأیید شود → برندگان `claim()`.
گوش دهید به: `MarketCreated`.
خطاهای رایج: نبود ADMIN_ROLE، خطای زمان‌بندی هنگام ساخت (`InvalidTiming`).

## مرجع سریع توابع

| تابع | Visibility | Mutability | دسترسی | هدف |
| --- | --- | --- | --- | --- |
| `createMarket(params)` | external | payable | ADMIN_ROLE | کلون CPMM با seed |
| `createMarket2(params)` | external | nonpayable | ADMIN_ROLE | کلون پاری‌موچل |
| `pauseMarket/unpauseMarket/closeMarket/voidMarket(id)` | external | nonpayable | ADMIN_ROLE | رلهٔ چرخهٔ حیات |
| confirmResolution(id,outcome) | external | nonpayable | امضاکنندهٔ حل | رأی به برنده؛ در حد نصاب اجرا می‌شود |
| setResolutionSigners(signers,n) | external | nonpayable | مالک کارخانه | تعویض مجموعهٔ امضاکننده‌ها + حد نصاب |
| viewهای مولتی‌سگ | external | view | همه | وضعیت رأی‌ها و امضاکننده‌ها |
| `setTreasury(t)` | external | nonpayable | ADMIN_ROLE | خزانهٔ بازارهای آینده |
| `repointTreasury(id)` | external | nonpayable | ADMIN_ROLE | همگام‌سازی خزانهٔ یک کلون |
| `setDefaultFees(f,s)` | external | nonpayable | ADMIN_ROLE | پیش‌فرض بازارهای feeBps=0 |
| viewهای رجیستری | external/public | view | همه | فهرست و جستجو |

