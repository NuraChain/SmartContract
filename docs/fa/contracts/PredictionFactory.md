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
| `MAX_FEE_BPS` | `uint16` | public | constant | ‏`1000`؛ سقف کارمزد ۱۰٪ برای بازارهای جدید. |
| `marketImplementation` | `address` | public | **immutable** | پیاده‌سازی CPMM که `createMarket` کلون می‌کند. |
| `poolImplementation` | `address` | public | **immutable** | پیاده‌سازی پاری‌موچل که `createMarket2` کلون می‌کند. |
| `_treasury` | `address` | private | mutable | خزانه‌ای که به بازارهای جدید اعمال می‌شود. |
| `defaultFeeBps` | `uint16` | public | mutable | کارمزدی که وقتی پارامترها `feeBps == 0` بدهند به ارث می‌رسد؛ همین‌جا درصد کارمزد به نوع/دستهٔ بازار گره می‌خورد. |
| `_records` | `MarketRecord[]` | private | mutable | رجیستری بر اساس marketId. |
| `_kinds` | `mapping(uint256 => MarketKind)` | private | mutable | marketId ← نوع موتور (`Amm`=0 پیش‌فرض، ‏`Pool`=1). |
| `_byStatus` | `mapping(MarketStatus => EnumerableSet.UintSet)` | private | mutable | گذار O(1) وضعیت + فیلتر صفحه‌بندی‌شده. |

## Structs (از `PredictionTypes.sol`)

```text
MarketParams  (پارامترهای ساخت که به initializer کلون می‌رود)
├── title, description, imageURI : string   -- متادیتا
├── categoryId           : uint32   -- شناسهٔ غیرصفر در رجیستری دسته‌های کارخانه
├── creator              : address  -- حسابی که به‌عنوان سازنده/LP اول ثبت می‌شود
├── lockTime             : uint64   -- پایان معامله/شرط‌بندی
├── resolveTime          : uint64   -- زمان هدف حل (اطلاعاتی)
├── feeBps               : uint16   -- کارمزد کل؛ صفر ⇒ پیش‌فرض کارخانه
└── outcomeNames         : string[] -- بین ۲ تا ۱۶ نام؛ طول = تعداد خروجی‌ها

MarketRecord  (اسنپ‌شات رجیستری)
├── market      : address  -- آدرس کلون
├── creator     : address
├── title       : string
├── categoryId  : uint32
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
| `MarketCreated` | `marketId, market, creator, categoryId, outcomeCount, initialFunding` | سه‌تای اول | `createMarket` (‏initialFunding = msg.value) یا `createMarket2` (۰) |
| `CategoryAdded` | `categoryId` | indexed | `addCategory` |
| `CategoryMeaningSet` | `categoryId, lang, meaning` | دوتای اول | `addCategory` و `setCategoryMeanings`، به‌ازای هر زبانِ نوشته‌شده |
| `CategoryEnabledSet` | `categoryId, enabled` | categoryId | `addCategory` (true) و `setCategoryEnabled` |
| `TreasuryUpdated` | `treasury` | indexed | `setTreasury` |
| `FeesUpdated` | `feeBps` | ندارد | `setDefaultFees` |

رویدادهای معامله/چرخهٔ حیات را خود کلون‌ها صادر می‌کنند (اعلام مشترک در
`PredictionEvents.sol`)؛ ایندکسرها باید به آدرس کلون گوش دهند.

## خطاها

| خطا | شرط وقوع | مسیر |
| --- | --- | --- |
| `ZeroAddress()` | سازنده: admin/treasury/هر implementation صفر؛ ‏`setTreasury(0)` | سازنده، setTreasury |
| `InvalidFee()` | ‏`feeBps > MAX_FEE_BPS` | سازنده، setDefaultFees |
| `AccessControlUnauthorizedAccount` (OZ) | نبود ADMIN_ROLE | همهٔ توابع محافظت‌شده |
| خطاهای اعتبارسنجی کلون | پارامترهای بد داخل `initialize` کلون رد می‌شود (`InvalidOutcomeCount`, `InvalidTiming`, ... ) | createMarket/createMarket2 (revert اتمیک کل تراکنش) |

## توابع

### طبقه‌بندی

- **مدیریتی:** ‏`createMarket`, `createMarket2`, `pauseMarket`, `unpauseMarket`,
  `closeMarket`, `voidMarket`, `sweepUnclaimed`, `setMarketAutoDistribute`,
  `setTreasury`, `repointTreasury`, `setDefaultFees`, `addCategory`,
  `setCategoryMeanings`, `setCategoryEnabled`
- **بدون مجوز:** ‏`distributeMarket`
- **مولتی‌سگ حل:** ‏confirmResolution (امضاکننده‌ها)، ‏setResolutionSigners (مالک)
- **View:** ‏marketCount, marketAt, marketAddress, marketKind, 	reasury, 
esolutionSigners, 
equiredConfirmations, confirmationCount, confirmationOf, isResolutionSigner,
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
| `sweepUnclaimed(id)` *(ADMIN_ROLE)* | `sweepUnclaimed()` | ندارد — وضعیت پایانی دست‌نخورده می‌ماند |
| `setMarketAutoDistribute(id, enabled)` *(ADMIN_ROLE)* | `setAutoDistribute(enabled)` | ندارد |
| `distributeMarket(id, limit)` *(**همه**)* | `distribute(limit)` | ندارد |

marketId خارج از محدوده panic اندیس آرایه می‌دهد.

`sweepUnclaimed` تنها رله‌ای است که گذارِ رجیستری ندارد: وثیقه‌ای را که بازارِ
تعیین‌تکلیف‌شده هنوز نگه داشته به خزانه می‌برد و مبلغ را برمی‌گرداند. کارخانه فقط گیتِ
ادمین را فراهم می‌کند؛ زمان‌بندی را خودِ کلون اجرا می‌کند و تا وقتی بازار زنده است
(`MarketNotResolved`) یا پنجرهٔ یک‌سالهٔ برداشتش باز است (`ClaimWindowOpen`) رد می‌کند، پس
ادمین هرگز نمی‌تواند جلوی برنده را بگیرد. ‏`setMarketAutoDistribute` هم push هنگام
تعیین‌تکلیف را روشن/خاموش می‌کند، و `distributeMarket` عمداً **بدون مجوز** است: فقط وثیقهٔ
خودِ بازارِ تعیین‌تکلیف‌شده را به حساب‌هایی می‌برد که از قبل مستحق‌اند. هر سه روی هر دو
موتور کار می‌کنند.

## رجیستری دسته‌ها

بازارها زیر یک `categoryId` عددی ثبت می‌شوند؛ کلمه‌ای که کاربر می‌بیند اینجا زندگی می‌کند،
به‌ازای هر زبان یک‌بار. پس تغییر نام یا ترجمهٔ یک دسته، یک ویرایش در رجیستری است نه مهاجرت
روی تک‌تک بازارهایی که از آن استفاده کرده‌اند.

```solidity
function addCategory(uint32 categoryId, bytes8[] langs, string[] meanings) external;   // ADMIN_ROLE
function setCategoryMeanings(uint32 categoryId, bytes8[] langs, string[] meanings) external; // ADMIN_ROLE
function setCategoryEnabled(uint32 categoryId, bool enabled) external;                // ADMIN_ROLE
function categoryMeaning(uint32 categoryId, bytes8 lang) external view returns (string memory);
function categoryMeanings(uint32 categoryId) external view returns (bytes8[] langs, string[] meanings);
function categoryLanguages(uint32 categoryId) external view returns (bytes8[] memory);
function categoryIds() external view returns (uint32[] memory);
function categoryCount() external view returns (uint256);
function categoryState(uint32 categoryId) external view returns (bool known, bool enabled);
function marketsByCategory(uint32 categoryId, uint256 offset, uint256 limit) external view returns (MarketRecord[] memory);
function countByCategory(uint32 categoryId) external view returns (uint256);
```

- **تگ زبان** کد کوتاهی است که از چپ در `bytes8` چیده می‌شود: `"en"`، `"fa"`، `"pt-BR"`.
  تطبیق دقیق است و نرمال‌سازی ندارد؛ یک املا انتخاب کنید و به همان بمانید.
- **شناسهٔ ۰ رزرو است**، تا بازاری که `categoryId` نگرفته با `UnknownCategory` بلند شکست
  بخورد، نه اینکه در سطلی بی‌نام بیفتد.
- **‏`addCategory` باید `DEFAULT_LANG` را داشته باشد** (وگرنه `MissingDefaultMeaning`)،
  چون هر lookup به آن fallback می‌کند: دسته‌ای بدون آن، در هر زبانی که مترجم هنوز نرسیده
  خالی خوانده می‌شود. دستهٔ تازه فعال شروع می‌شود.
- **‏`setCategoryEnabled(id, false)`** دسته را فقط از بازارهای *جدید* بازنشسته می‌کند؛
  بازارهایی که از قبل زیر آن ثبت شده‌اند همچنان فهرست و خوانده و معامله می‌شوند.
- **خطاها:** ‏`UnknownCategory` (شناسهٔ ۰، ثبت‌نشده، یا بازنشسته هنگام ساخت بازار)،
  `CategoryExists`، ‏`BadCategoryInput` (ناهم‌خوانی طول آرایه‌ها، دستهٔ خالی، تگ یا نام
  خالی، یا عبور از `MAX_CATEGORY_LANGS`)، ‏`MissingDefaultMeaning`.

```text
addCategory(7, ["en", "fa"], ["Weather", "آب و هوا"])
createMarket2({ ..., categoryId: 7 })
categoryMeaning(7, "fa") -> "آب و هوا"
categoryMeaning(7, "tr") -> "Weather"        // ترجمه‌نشده: fallback به DEFAULT_LANG
marketsByCategory(7, 0, 20)                 // صفحه‌بندی‌شده، بدون اسکن رجیستری
```

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
- `setDefaultFees`: اعتبارسنجی با `MAX_FEE_BPS`؛ فقط بازارهای بعدی که صفر بدهند.

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
| `sweepUnclaimed(id)` | external | nonpayable | ADMIN_ROLE | انتقال باقیماندهٔ بازار تعیین‌تکلیف‌شده به خزانه، یک سال بعد |
| `setMarketAutoDistribute(id, enabled)` | external | nonpayable | ADMIN_ROLE | روشن/خاموش کردن push هنگام تعیین‌تکلیف |
| `distributeMarket(id, limit)` | external | nonpayable | **همه** | پرداخت به حداکثر `limit` حسابِ بعدیِ یک بازار تعیین‌تکلیف‌شده |
| `addCategory/setCategoryMeanings/setCategoryEnabled` | external | nonpayable | ADMIN_ROLE | رجیستری دسته‌ها |
| `categoryMeaning(s)/categoryLanguages/categoryIds/categoryCount/categoryState/marketsByCategory/countByCategory` | external | view | همه | خواندن دسته‌ها |
| `setDefaultFees(f)` | external | nonpayable | ADMIN_ROLE | پیش‌فرض بازارهای feeBps=0 |
| viewهای رجیستری | external/public | view | همه | فهرست و جستجو |

