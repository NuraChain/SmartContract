# CollateralizedNFT (خزانهٔ NFT وثیقه‌ای)

> نسخهٔ انگلیسی: [../../contracts/CollateralizedNFT.md](../../contracts/CollateralizedNFT.md)

## نمای کلی قرارداد

| ویژگی | مقدار |
| --- | --- |
| نام قرارداد | `CollateralizedNFT` |
| فایل سولیدیتی | `contracts/vault/CollateralizedNFT.sol` |
| نسخهٔ سولیدیتی | `^0.8.28` (solc 0.8.28، cancun) |
| نوع قرارداد | خزانهٔ ERC721 واقعی |
| هدف | هر NFT ادعایی بر مبلغ ثابتی از یک ERC20 نگه‌داشته‌شده در همین قرارداد است؛ ضرب، مقدار فعلی `lockAmount` را رزرو می‌کند و بازخرید توکن را می‌سوزاند و همان مبلغ را به مالک می‌پردازد |
| ارتقاءپذیر / پروکسی | خیر / خیر — عمداً (قانون بازخرید نمی‌تواند زیر پای دارنده‌ها عوض شود) |

مبلغ قفل‌شدهٔ هر توکن **هنگام ضرب** ثبت و دیگر تغییر نمی‌کند؛ `setLockAmount` فقط
ضرب‌های آینده را تعیین می‌کند. تضمین توانگری با دو ناوردا به‌صورت ساختاری اعمال می‌شود:

۱. ‏`totalReserved == Σ lockedAmount[id]` روی idهای زنده.
۲. ‏`totalReserved ≤ backingToken.balanceOf(this)` — فقط mint این عدد را بالا می‌برد و
اول موجودی آزاد را چک می‌کند؛ فقط بازخرید (هر دو طرف را مساوی کم می‌کند) و
`withdrawExcessTokens` (محدود به بخش آزاد) می‌توانند توکن خارج کنند.

حذف‌های عمدی (هر کدام راهی برای گرفتن وثیقهٔ دیگران بود): بدون pause روی `redeem`، بدون
ERC721Burnable، بدون ارتقاءپذیری، `backingToken` غیرقابل‌تغییر.

## وراثت

```text
CollateralizedNFT
├── ERC721           -- هستهٔ NFT؛ _safeMint/_burn/_requireOwned و رویدادها
├── AccessControl    -- DEFAULT_ADMIN_ROLE و MINTER_ROLE
└── ReentrancyGuard  -- محافظ deposit/mint/redeem/withdraw/rescue
```

تمام تماس‌های ERC20 با `SafeERC20` انجام می‌شود.

## اینترفیس‌ها

| اینترفیس | تعامل |
| --- | --- |
| `IERC20` | توکن پشتوانه: `balanceOf`، ‏`safeTransferFrom` (واریز)، ‏`safeTransfer` (بازخرید/برداشت/rescue). همیشه از طریق SafeERC20. |
| `IERC721` / `IAccessControl` / `ERC165` | سطوح پیاده‌سازی‌شده (`supportsInterface` تعارض ERC721×AccessControl را حل می‌کند). |

مرتبط: [`IBackingToken`]‏ (`contracts/vault/IBackingToken.sol`) — نام مستعار
`IERC20Metadata` صرفاً برای ابزارها و `scripts/vault-setup.ts`؛ خود قرارداد از آن استفاده
نمی‌کند.

## متغیرهای State

| متغیر | نوع | دید | تغییرپذیری | هدف |
| --- | --- | --- | --- | --- |
| `MINTER_ROLE` | `bytes32` | public | constant | اجازهٔ mint تا وقتی ضرب عمومی خاموش است. توجه: minter می‌تواند از **بخش آزاد** موجودی برای خودش برداشت کند (mint→redeem)؛ حسابداری رزرو فقط وثیقهٔ *سایرین* را محافظت می‌کند. |
| `backingToken` | `IERC20` | public | **immutable** | تنها ERC20 پشت هر NFT؛ immutable تا ادعاهای زنده هرگز به توکنی که قرارداد نگه نمی‌دهد اشاره نکنند. |
| `lockAmount` | `uint256` | public | mutable | رزرو هر NFT برای ضرب‌های آینده (در اعشار توکن). |
| `totalReserved` | `uint256` | public | mutable | جمع قفل‌ها روی idهای زنده؛ با ساختار، هرگز از موجودی بیشتر نمی‌شود. |
| `totalMinted` | `uint256` | public | mutable | کل ضرب‌ها؛ شمارندهٔ id هم هست (idها 1..totalMinted). |
| `totalRedeemed` | `uint256` | public | mutable | کل بازخریدها. |
| `publicMintEnabled` | `bool` | public | mutable | وقتی false فقط MINTER_ROLE ضرب می‌کند. **در دیپلوی خاموش.** |
| `lockedAmount` | `mapping(uint256 => uint256)` | public | mutable | کلید: tokenId → wei قابل بازخریدِ دقیقاً همان id. برای id ناموجود صفر. |
| `_baseTokenURI` | `string` | private | mutable | پیشوند متادیتا برای `_baseURI()`. |

## Structs / Enumها

ندارد.

## Modifierها

| Modifier | منبع | استفاده در | اثر |
| --- | --- | --- | --- |
| `onlyRole(DEFAULT_ADMIN_ROLE)` | AccessControl | ستترها و برداشت‌های ادمین | مدیریت فقط توسط ادمین |
| `nonReentrant` | ReentrancyGuard | تمام نقاط ورود پولی | بستن reentrancy حول callbackهای ERC20/ERC721 |

## رویدادها

| رویداد | پارامترها | Indexed | محل صدور |
| --- | --- | --- | --- |
| `Deposited` | `from, amount, newBalance` | `from` | واریز؛ `amount` = افزایش واقعی موجودی (ایمن نسبت به fee-on-transfer) |
| `NFTMinted` | `recipient, tokenId, lockedAmount` | هر دو اول | هر ضرب همراه مبلغ رزروشدهٔ دائمی آن id |
| `NFTRedeemed` | `owner, tokenId, returnedAmount` | هر دو اول | پرداخت بازخرید |
| `LockAmountUpdated` | `previousAmount, newAmount` | ندارد | تغییر نرخ آینده |
| `PublicMintUpdated` | `enabled` | ندارد | باز/بسته شدن ضرب عمومی |
| `BaseURIUpdated` | `newBaseURI` | ندارد | تغییر متادیتا |
| `ExcessTokensWithdrawn` | `to, amount` | `to` | برداشت بخش آزاد |
| `TokensRescued` | `token, to, amount` | `token`, `to` | sweep توکن بیگانه |

به‌علاوه `Transfer`، ‏`Approval` و `ApprovalForAll` استاندارد ERC721.

## خطاها

| خطا | شرط وقوع | مسیر | اجتناب |
| --- | --- | --- | --- |
| `ZeroAddress()` | admin/backingToken صفر در سازنده؛ گیرنده یا مقصد برداشت صفر | سازنده، mintها، برداشت‌ها | آدرس واقعی |
| `ZeroAmount()` | قفل صفر در سازنده؛ واریز ۰؛ `setLockAmount(0)`؛ برداشت ۰ | مسیرهای مربوط | مقادیر مثبت |
| `ZeroQuantity()` | ‏`mintBatch(recipient, 0)` | mintBatch | quantity ≥ 1 |
| `InsufficientBacking(available, required)` | موجودی آزاد کافی نیست | `_reserve`، ‏`withdrawExcessTokens` | ابتدا واریز / مبلغ کمتر |
| `NotTokenOwner(tokenId, owner, caller)` | caller ≠ مالک فعلی در بازخرید | `redeem`, `burn` | از حساب مالک |
| `MintNotPermitted(caller)` | ضرب عمومی خاموش و نبود MINTER_ROLE | `mint`, `mintBatch` | نقش بگیرید یا منتظر ضرب عمومی |
| `BackingTokenNotRescuable()` | rescue با خودِ توکن پشتوانه | rescueERC20 | از `withdrawExcessTokens` استفاده کنید |
| (ارثی) خطاهای ERC721 | گیرندهٔ نامعتبر؛ id ناموجود | mint/redeem | ورودی معتبر |

## توابع

### طبقه‌بندی

- **کاربر:** `deposit`، ‏`mint`*، ‏`mintBatch`* (*وقتی ضرب عمومی روشن است)، ‏`redeem`، ‏`burn`
- **مالی:** `deposit`، ‏`redeem`/`burn` (پرداخت)، ‏`withdrawExcessTokens`، ‏`rescueERC20`
- **مدیریتی:** `setLockAmount`, `setPublicMintEnabled`, `setBaseURI`,
  `withdrawExcessTokens`, `rescueERC20`
- **View:** ‏`tokenBalance`, `availableBacking`, `remainingMintCapacity`, `totalSupply`,
  `vaultState` (+ getterهای ERC721)
- **Private:** ‏`_requireCanMint`, `_reserve`, `_mintOne`, `_redeem`, `_baseURI`

---

### deposit

```solidity
function deposit(uint256 amount) external nonReentrant;
```

با `safeTransferFrom` مقدار `amount` توکن پشتوانه را از فراخواننده می‌کشد. اختلاف
موجودی قبل/بعد اندازه می‌شود تا توکن‌های fee-on-transfer درست ثبت شوند. برای همه آزاد
است (انتقال ساده هم همین کار را می‌کند، فقط بدون رویداد). نیاز به approval قبلی دارد.

---

### mint

```solidity
function mint(address recipient) external nonReentrant returns (uint256 tokenId);
```

**دسترسی:** همه اگر `publicMintEnabled` وگرنه `MINTER_ROLE`.
جریان: چک مجوز → گیرنده ≠ 0 → `_reserve(1)` (چک + ثبت `lockAmount`) → `_mintOne`:
‏id = `++totalMinted`، نوشتن `lockedAmount[id]`، صدور `NFTMinted` و **آخر از همه**
`_safeMint` (همهٔ effects قبل از callback گیرنده؛ reentry با nonReentrant بسته).

---

### mintBatch

```solidity
function mintBatch(address recipient, uint256 quantity) external nonReentrant returns (uint256 firstTokenId);
```

رزرو `quantity × lockAmount` با یک چک (revert اتمیک به‌جای پیشوندِ نیمه‌پشتیبان)، سپس
حلقهٔ `_mintOne`. idها از `firstTokenId` تا `+quantity-1`. حجم دسته فقط محدود به گاس
بلاک است.

---

### redeem / burn

```solidity
function redeem(uint256 tokenId) external nonReentrant;
function burn(uint256 tokenId)   external nonReentrant;  // نام مستعار
```

**دسترسی:** فقط مالک فعلی — approval/operator عمداً کفایت نمی‌کند (اجازهٔ جابه‌جایی NFT
اجازهٔ نقد کردن آن نیست). پرداخت به خود مالک است؛ آرگومان مقصد وجود ندارد که قابل انحراف
باشد.

جریان (`_redeem`): ‏`_requireOwned(tokenId)` → چک برابری مالک → خواندن مبلغ →
**ابتدا effects:** ‏`delete lockedAmount[id]`، کم شدن `totalReserved`، افزایش
`totalRedeemed`، ‏`_burn(tokenId)` → صدور `NFTRedeemed` →
`backingToken.safeTransfer(owner, amount)`.

---

### توابع View

```solidity
tokenBalance()          // موجودی کل توکن پشتوانه
availableBacking()      // اشباع‌شونده: balance - totalReserved (هرگز revert نمی‌شود)
remainingMintCapacity() // availableBacking() / lockAmount
totalSupply()           // totalMinted - totalRedeemed  (IERC721Enumerable نیست؛ عمدی)
vaultState()            // تصویر کامل حسابداری در یک فراخوانی
```

به‌علاوه getterهای ERC721: ‏`balanceOf`, `ownerOf`, `name`, `symbol`, `tokenURI`
(baseURI + شناسهٔ دهدهی), `getApproved`, `isApprovedForAll`.

---

### توابع مدیریتی

```solidity
setLockAmount(new)        // DEFAULT_ADMIN؛ فقط ضرب‌های آینده
setPublicMintEnabled(b)   // DEFAULT_ADMIN؛ هشدار زیر
setBaseURI(uri)           // DEFAULT_ADMIN؛ فقط متادیتا
withdrawExcessTokens(to,amount) // DEFAULT_ADMIN + nonReentrant؛ محدود به availableBacking()
rescueERC20(token,to,amount)    // DEFAULT_ADMIN + nonReentrant؛ خودِ توکن پشتوانه ممنوع
```

**هشدار `setPublicMintEnabled(true)`:** ضرب رایگان است (از رزرو پشتیبان می‌شود)، پس ضرب
عمومی یعنی هر کس mint+redeem کند و با بقیه بر سر کل رزروِ آزاد مسابقه بگذارد. فقط وقتی
منطقی است که شرایط جای دیگری اعمال شود (مثلاً قرارداد فروشی که خودش MINTER_ROLE دارد).

## کنترل دسترسی

| تابع | نقش لازم | چه کسی |
| --- | --- | --- |
| `deposit` | ندارد | همه با allowance |
| `mint`/`mintBatch` | هیچ اگر ضرب عمومی، وگرنه MINTER_ROLE | عموم / minters |
| `redeem`/`burn` | مالکیت توکن | مالک فعلی |
| ستترها و برداشت‌های ادمین | `DEFAULT_ADMIN_ROLE` | ادمین |

**اختیارات CRITICAL:**‏ `withdrawExcessTokens` (تا کل بخش آزاد)،
`setPublicMintEnabled(true)` (بازکردن مسابقهٔ mint رایگان)، ‏`rescueERC20`. نه ادمین و
نه minter به وثیقهٔ پشت NFT زندهٔ *دیگری* دست نمی‌رسند — دقیقاً کاری که ناورداها
می‌کنند.

## جریان مالی

```text
تأمین‌کننده ──approve──▶ CollateralizedNFT ──deposit──▶ استخر رزرو
Minter ──mint(n)──▶ n عدد NFT + totalReserved += n·lockAmount
مالک ──redeem(id)─▶ سوزاندن NFT ──safeTransfer(lockedAmount[id])──▶ مالک
ادمین ──withdrawExcessTokens──▶ فقط دُمِ آزاد
```

## تحلیل امنیتی

| حوزه | نتیجه |
| --- | --- |
| Reentrancy | **مشکلی دیده نشد** — CEI در همه‌جا؛ callback `_safeMint` پس از ثبت کامل؛ backstop ‏nonReentrant |
| توانگری | **برقرار** — ناورداها ساختاری هستند |
| مصادرهٔ وثیقهٔ زندهٔ دیگران | **مسیر ندارد** — بازخرید فقط مالک؛ سوزاندن-بدون-پرداخت ناممکن؛ rescue توکن پشتوانه را رد می‌کند |
| توکن‌های fee-on-transfer | واریز با اختلاف اندازه‌گیری می‌شود؛ اگر *توکن پشتوانه* FoT باشد بازخرید کسری تحویل می‌دهد — به‌عنوان پشتوانه استفاده نشود |
| توکن‌های rebasing | **ریسک بالقوه** — rebasing منفی می‌تواند موجودی را زیر totalReserved ببرد؛ redemptions first-come-first-served می‌شوند |
| تمرکز | **ملاحظهٔ طراحی** — ادمین نرخ آینده، گیت ضرب و دُم آزاد را کنترل می‌کند |
| DoS | چیزی فراتر از گاز ندارد |

## اطلاعات دیپلوی

- شبکه: Nurachain (1020). آدرس: Not found in repository.
- دیپلوی: ‏`ignition/modules/vault.ts` نیازمند پارامتر آدرس توکن؛ فاندینگ با
  `npm run setup:nurachain:vault`.

## راهنمای یکپارچه‌سازی

خواندن: `vaultState()` برای داشبورد؛ ‏`remainingMintCapacity()` قبل از mint گروهی.
جریان کاربر: ‏`approve` → ‏`mint` → بعداً `redeem(id)`.
گوش دهید به: `NFTMinted`, `NFTRedeemed`, `Deposited`, `ExcessTokensWithdrawn`.
خطاهای رایج: ‏`InsufficientBacking`، ‏`MintNotPermitted`، ‏`NotTokenOwner`.

## مرجع سریع توابع

| تابع | Visibility | Mutability | دسترسی | هدف |
| --- | --- | --- | --- | --- |
| `deposit(amount)` | external | nonpayable | همه | افزودن توکن پشتوانه |
| `mint(recipient)` | external | nonpayable | نقش/عمومی | ضرب یک NFT پشتیبان‌شده |
| `mintBatch(recipient,q)` | external | nonpayable | نقش/عمومی | ضرب q عدد |
| `redeem(tokenId)` | external | nonpayable | مالک | سوزاندن + پرداخت |
| `burn(tokenId)` | external | nonpayable | مالک | نام مستعار redeem |
| `tokenBalance()` | public | view | همه | کل پشتوانهٔ نگه‌داشته |
| `availableBacking()` | public | view | همه | پشتوانهٔ آزاد |
| `remainingMintCapacity()` | public | view | همه | ظرفیت ضرب |
| `totalSupply()` | external | view | همه | NFTهای زنده |
| `vaultState()` | external | view | همه | تصویر کامل حسابداری |
| `setLockAmount(new)` | external | nonpayable | DEFAULT_ADMIN | نرخ ضرب آینده |
| `setPublicMintEnabled(b)` | external | nonpayable | DEFAULT_ADMIN | گیت ضرب |
| `setBaseURI(uri)` | external | nonpayable | DEFAULT_ADMIN | متادیتا |
| `withdrawExcessTokens(to,amt)` | external | nonpayable | DEFAULT_ADMIN | برداشت بخش آزاد |
| `rescueERC20(t,to,amt)` | external | nonpayable | DEFAULT_ADMIN | sweep توکن بیگانه |
| `supportsInterface(id)` | public | view | همه | ERC-165 |
