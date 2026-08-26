# بریج‌تُکن (BridgeToken)

> نسخهٔ انگلیسی: [../../contracts/BridgeToken.md](../../contracts/BridgeToken.md)

## نمای کلی قرارداد

| ویژگی | مقدار |
| --- | --- |
| نام قرارداد | `BridgeToken` |
| فایل سولیدیتی | `contracts/token/BridgeToken.sol` |
| نسخهٔ سولیدیتی | `^0.8.28` (کامپایل با solc 0.8.28 و evmVersion `cancun`) |
| نوع قرارداد | `abstract contract` — پایهٔ مشترک، هرگز مستقیم دیپلوی نمی‌شود |
| هدف | پیاده‌سازی مشترک برای دارایی‌های پل‌زده (wrapped) که عرضه‌شان با ورود انتقال از زنجیرهٔ مبدأ ضرب و با خروج، سوزانده می‌شود |
| ارتقاء‌پذیر | خیر |
| پروکسی | خیر |
| مجوز | MIT |

`BridgeToken` یک پایهٔ ERC20 برای توکن‌های بازنماییِ پلی است. عرضه **روی زنجیره پشتوانه
ندارد**: رله‌ای که `MINTER_ROLE` دارد هنگام مشاهدهٔ واریز در زنجیرهٔ مبدأ ضرب می‌کند و
`BURNER_ROLE` هنگام خروج کاربر می‌سوزاند. پس هر واحد توکن کاملاً به پایبندی اپراتور پل
به پشتوانهٔ ۱:۱ وابسته است.

دو اختیار عمدیِ اپراتوری وجود دارد و همین‌طور مستند شده:

- `adminBurn()` موجودی **هر** دارنده را بدون نیاز به allowance نابود می‌کند.
- `pause()` همهٔ انتقال‌ها، ضرب‌ها و سوزاندن‌ها را متوقف می‌کند.

دیپلوی‌های واقعی: [`BridgeUSDT`](BridgeUSDT.md) و [`BridgeBNB`](BridgeBNB.md).

## وراثت

```text
BridgeToken (abstract)
├── ERC20              -- هستهٔ استاندارد توکن: موجودی‌ها، تأییدیه‌ها، رویدادهای Transfer/Approval
├── ERC20Burnable      -- burn()/burnFrom() توسط خود دارنده (بر پایهٔ allowance)
├── ERC20Pausable      -- هوک _update؛ در حالت pause همهٔ انتقال‌ها revert می‌شود
├── AccessControl      -- دسترسی نقش‌محور (DEFAULT_ADMIN/MINTER/BURNER/PAUSER)
└── ERC20Permit        -- تأیید بی‌گاز EIP-2612 با امضای secp256k1
```

| پایه | دلیل ارث‌بری |
| --- | --- |
| `ERC20` | هستهٔ توکن؛ `_update` تنها هوک تغییر موجودی است که بقیهٔ پایه‌ها از آن عبور می‌کنند. |
| `ERC20Burnable` | رفتار استاندارد دارنده (`burn`/`burnFrom`) در کنار `adminBurn` مدیریتی حفظ می‌شود. مبتنی بر allowance است. |
| `ERC20Pausable` | `_update` را override می‌کند تا در حالت pause برگشت بخورد؛ در `_update` زیر با `ERC20._update` حل تعارض شده. |
| `AccessControl` | مدل دسترسی چهارنقشی؛ هر تابع مدیریتی با `onlyRole(...)` محافظت شده. |
| `ERC20Permit` | `permit()` استاندارد EIP-2612؛ نام دامنه برابر نام توکن است (`ERC20Permit(name_)`). |

## اینترفیس‌ها

| اینترفیس | هدف / تعامل |
| --- | --- |
| `IERC20` (OpenZeppelin) | نوع پارامتر `rescueERC20`؛ توکن جمع‌آوری‌شده با `SafeERC20.safeTransfer` جابه‌جا می‌شود. |
| `IERC20Permit` (از طریق `ERC20Permit`) | سطح استاندارد EIP-2612 برای دارنده‌ها. |
| `IAccessControl` (از طریق `AccessControl`) | بررسی نقش‌ها برای فرانت‌اند/تست‌ها (`hasRole`, `getRoleAdmin`, ...). |

## متغیرهای State

| متغیر | نوع | دید (Visibility) | تغییرپذیری | هدف |
| --- | --- | --- | --- | --- |
| `MINTER_ROLE` | `bytes32` | public | `constant` | شناسهٔ نقش (`keccak256("MINTER_ROLE")`) لازم برای `mint`/`mintBatch`. |
| `BURNER_ROLE` | `bytes32` | public | `constant` | شناسهٔ نقش لازم برای `adminBurn`. |
| `PAUSER_ROLE` | `bytes32` | public | `constant` | شناسهٔ نقش لازم برای `pause`/`unpause`. |
| `_tokenDecimals` | `uint8` | private | `immutable` | اعشار ثابت از زمان ساخت؛ توسط `decimals()` بازگردانده می‌شود. باید با داراییِ زنجیرهٔ مبدأ یکی باشد. |

State ارثی مهم: `AccessControl._roles` (نقش ← دادهٔ نقش شامل اعضا)،
`ERC20Permit._PERMIT_NONCES` (nonce هر مالک)، `ERC20Pausable._paused` (از `Pausable`).

## ساختارها (Structs)

در این قرارداد هیچ Structی اعلام نشده. (ارثی: `AccessControl.RoleData`
— `{members, adminRole}`.)

## Enumها

ندارد.

## ثابت‌ها و Immutables

| نام | نوع | مقدار | هدف / اهمیت |
| --- | --- | --- | --- |
| `MINTER_ROLE` | `bytes32` | `keccak256("MINTER_ROLE")` | گیت ایجاد عرضه؛ لو رفتن کلید minter یعنی ضرب بدون پشتوانه. |
| `BURNER_ROLE` | `bytes32` | `keccak256("BURNER_ROLE")` | گیت سوزاندن بدون قید و شرط از هر حسابی. |
| `PAUSER_ROLE` | `bytes32` | `keccak256("PAUSER_ROLE")` | گیت توقف سراسری انتقال‌ها. |
| `_tokenDecimals` | `uint8` | آرگومان constructor | اعشار ثابت (۱۸ برای هر دو توکن). |

## Modifierها

| Modifier | منبع | شرط | جلوگیری از | استفاده‌شده در |
| --- | --- | --- | --- | --- |
| `onlyRole(role)` | `AccessControl` | `hasRole(role, msg.sender)` | فراخوانی غیرمجاز توابع مدیریتی | `mint`, `mintBatch`, `adminBurn`, `pause`, `unpause`, `rescueERC20` |
| `whenNotPaused` | `Pausable` | `!paused()` | هر جابه‌جایی در زمان توقف (داخل `ERC20._update` و `burn*`) | همهٔ حرکت توکن هنگام freeze |

## رویدادها (Events)

| رویداد | پارامترها | Indexed | محل صدور |
| --- | --- | --- | --- |
| `BridgeMint` | `to, amount, operator` | `to`, `operator` | هر `mint` موفق و هر عنصر `mintBatch` |
| `BridgeBurn` | `from, amount, operator` | `from`, `operator` | `adminBurn` موفق |
| `TokensRescued` | `token, to, amount` | `token`, `to` | `rescueERC20` موفق |

همچنین `Transfer` و `Approval` استاندارد ERC20، رویداد permit و `Paused`/`Unpaused`.
ایندکسرها باید `BridgeMint`/`BridgeBurn` را دفتر تسویهٔ پل بدانند (شناسهٔ اپراتور را
حمل می‌کنند).

## خطاها (Errors)

| خطا | پارامتر | شرط وقوع | مسیر فراخوانی | راه اجتناب |
| --- | --- | --- | --- | --- |
| `ZeroAddress()` | — | صفر بودن admin در سازنده؛ `to == 0` در rescue | سازنده، `rescueERC20` | آدرس واقعی بفرستید |
| `ArrayLengthMismatch(recipients, amounts)` | دو `uint256` | طول آرایه‌های `mintBatch` نابرابر | `mintBatch` | هم‌طول کردن آرایه‌ها |
| `EmptyBatch()` | — | `mintBatch` با آرایهٔ خالی | `mintBatch` | حداقل یک جفت |
| (ارثی) `EnforcedPause()` | — | هر انتقال/ضرب/سوزاندن در حالت pause | همهٔ جابه‌جایی‌ها | منتظر `unpause` |
| (ارثی) خطاهای ECDSA | — | امضای نامعتبر permit | `permit` | امضای صحیح |

## توابع

### طبقه‌بندی

- **مدیریتی:** `mint`, `mintBatch`, `adminBurn`, `pause`, `unpause`, `rescueERC20`
- **مالی:** `mint`, `mintBatch`, `adminBurn`, `rescueERC20`؛ و ارثی‌ها:
  `burn`, `burnFrom`, `transfer`, `transferFrom`, `permit`
- **View:** `decimals` (override)؛ getterهای ERC20/Permit/AccessControl
- **Internal:** `_update`

---

### mint

```solidity
function mint(address to, uint256 amount) external;
```

**هدف:** ضرب `amount` توکن برای `to` — بخش on-chain انتقال ورودی پل.

**پارامترها:** `to` دریافت‌کننده، `amount` مقدار در واحد پایه.
بدون مقدار بازگشتی. external / nonpayable. **دسترسی:** `MINTER_ROLE`.

**پیش‌شرط‌ها:** عدم pause؛ `to != address(0)` (در `_mint` چک می‌شود).

**جریان اجرا:** ۱. چک نقش. ۲. `_mint(to, amount)` (به‌روزرسانی موجودی‌ها و totalSupply +
`Transfer(0x0→to)`). ۳. صدور `BridgeMint(to, amount, msg.sender)`.

**تغییرات state:** موجودی‌ها، `totalSupply`. **رویدادها:** `Transfer`, `BridgeMint`.
**خطاها:** `EnforcedPause`.

**امنیت:** متمرکزگرایی — دارندهٔ MINTER_ROLE هر زمان بخواهد عرضهٔ بدون پشتوانه می‌سازد؛
هیچ اثبات on-chainی برای واریز متناظر وجود ندارد (و محافظت replay هم نیست — یادداشت
README مخزن).

---

### mintBatch

```solidity
function mintBatch(address[] calldata recipients, uint256[] calldata amounts) external;
```

**هدف:** تسویهٔ اتمیک چند انتقال ورودی.

**جریان اجرا:** ۱. برابری طول آرایه‌ها → وگرنه `ArrayLengthMismatch`. ۲. چک خالی بودن →
`EmptyBatch`. ۳. حلقه: `_mint` + `BridgeMint` به‌ازای هر عنصر.

**خطاها:** `ArrayLengthMismatch`, `EmptyBatch`, `EnforcedPause`.

**امنیت:** حجم دسته فقط با گس بلاک محدود است؛ all-or-nothing است (یک عضو خراب کل دسته را
revert می‌کند).

---

### adminBurn

```solidity
function adminBurn(address from, uint256 amount) external;
```

**هدف:** نابودی `amount` از `from` برای انتقال خروجی پل — **بدون** allowance یا امضا.

**جریان اجرا:** `_burn(from, amount)` (+ `Transfer(from→0x0)`) سپس صدور
`BridgeBurn(from, amount, msg.sender)`.

**خطاها:** panic کمبود موجودی (0x11)؛ `EnforcedPause`.

**امنیت:** قدرت CRITICAL: می‌تواند توکن هر دارنده‌ای را مصادره کند؛ عمدی است اما باید
پشت multisig/timelock باشد.

---

### pause / unpause

```solidity
function pause() external;   // PAUSER_ROLE
function unpause() external; // PAUSER_ROLE
```

توقف/ادامهٔ همهٔ انتقال‌ها، ضرب و سوزاندن با تغییر `Pausable._paused`.
رویدادهای `Paused`/`Unpaused`. **امنیت:** توقف، وجه اشخاص ثالث را منجمد می‌کند.

---

### rescueERC20

```solidity
function rescueERC20(IERC20 token, address to, uint256 amount) external;
```

**هدف:** جمع‌آوری توکن‌هایی که به‌اشتباه به آدرس قرارداد رسیده‌اند (شامل توکن خودش).

**جریان اجرا:** چک آدرس صفر → `SafeERC20.safeTransfer(token, to, amount)` → `TokensRescued`.

**خطاها:** `ZeroAddress`؛ revert خود توکن.

**امنیت:** sweep توکن دلخواه فقط توسط ادمین؛ اجازهٔ کاربران را نمی‌دزدد (فقط موجودیِ
قرارداد را جابه‌جا می‌کند).

---

### decimals (override)

```solidity
function decimals() public view returns (uint8);
```

`_tokenDecimals` را برمی‌گرداند نه پیش‌فرض ۱۸ ERC20. public / view / همه.

---

### _update (internal override)

```solidity
function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Pausable);
```

هوک خطی‌شده تا هم دفترداری ERC20 و هم گیت pause اجرا شود:
`super._update(...)` ابتدا `ERC20Pausable._update` (چک pause) را و بعد `ERC20._update` را
اجرا می‌کند. در تمام مسیرهای انتقال/ضرب/سوزاندن صدا زده می‌شود.

---

### API عمومی ارثی

`name`, `symbol`, `totalSupply`, `balanceOf`, `transfer`, `allowance`, `approve`,
`transferFrom`, `increaseAllowance`, `decreaseAllowance`, `burn`, `burnFrom`,
`permit`, `nonces`, `DOMAIN_SEPARATOR`, `paused`, `hasRole`, `getRoleAdmin`,
`grantRole`, `revokeRole`, `renounceRole`, `supportsInterface` — رفتار استاندارد
OpenZeppelin 5.x؛ `grantRole/revokeRole` نیازمند ادمینِ همان نقش (DEFAULT_ADMIN_ROLE) است.

## کنترل دسترسی

| تابع | نقش لازم | چه کسی |
| --- | --- | --- |
| `mint` / `mintBatch` | `MINTER_ROLE` | اپراتور پل |
| `adminBurn` | `BURNER_ROLE` | اپراتور پل |
| `pause` / `unpause` | `PAUSER_ROLE` | کلید امنیتی اپراتور |
| `rescueERC20` | `DEFAULT_ADMIN_ROLE` | ادمین |
| `grantRole` / `revokeRole` | ادمینِ نقش (`DEFAULT_ADMIN_ROLE`) | ادمین |
| بقیه | ندارد | همه |

**اختیارات مدیریتی CRITICAL:** `mint*` (تورم بدون پشتوانه)، `adminBurn` (مصادره)،
`pause` (فریز سراسری)، `rescueERC20` (sweep). در دیپلوی هر چهار نقش روی یک آدرس `admin`
است — پیش از جریان ارزش واقعی به multisig منتقل کنید.

## جریان مالی توکن

```text
مشاهدهٔ واریز در زنجیرهٔ مبدأ (خارج از زنجیره)
   ↓
MINTER_ROLE ‏mint()/mintBatch()‎ می‌زند
   ↓
کاربر توکن پل‌زده را می‌گیرد (Transfer + BridgeMint)
   ↓ (خروج)
BURNER_ROLE ‏adminBurn()‎ می‌زند → رله دارایی را در زنجیرهٔ مبدأ آزاد می‌کند
```

توکن‌های سرگردان در قرارداد: ادمین → `rescueERC20` → مقصد انتخابی.

## تحلیل امنیتی

- **تأییدشده به‌عنوان طراحی (فرض اعتماد):** نبود اثبات on-chain پشتوانه؛ نبود محافظت
  replay برای mint؛ مصادره با `adminBurn`؛ قابل-pause بودن انتقال‌ها.
- **Reentrancy:** موضوعیت ندارد — جز `SafeERC20` در rescue تماس خارجی ندارد.
- **Overflow:** ریاضیات checked سولیدیتی 0.8 + هستهٔ حسابرسی‌شده OZ 5.x.
- **Permit:** EIP-2612 استاندارد OZ؛ nonce + دامنه `(name, version "1", chainId, this)`.
- **تمرکز:** در ابتدا هر چهار نقش روی یک ادمین.

## ارتقاءپذیری

ندارد. توکن‌های واقعی سازندهٔ ساده دارند و پس از دیپلوی تغییرناپذیرند.

## اطلاعات دیپلوی

ببینید [BridgeUSDT](BridgeUSDT.md) / [BridgeBNB](BridgeBNB.md). دیپلوی با
`ignition/modules/token.ts` (`npm run deploy:nurachain:token`). شبکه: Nurachain (1020).

## راهنمای یکپارچه‌سازی

- ABI:‏ `web/application/src/config/abi/BridgeUSDT.json` / `BridgeBNB.json`.
- خواندنی‌ها: `balanceOf`, `allowance`, `paused`, `decimals`, `nonces`, `DOMAIN_SEPARATOR`.
- نوشتنی‌ها (کاربر): `approve`, `transfer`, `permit`؛ (رله): `mint`, `mintBatch`, `adminBurn`؛
  (ادمین): `pause`, `rescueERC20`, مدیریت نقش‌ها.
- گوش دهید به: `Transfer`, `BridgeMint`, `BridgeBurn`, `Paused`, `Unpaused`.
- خطاهای رایج: `EnforcedPause` در حوادث؛ replay permit → `ERC2612InvalidSigner`.

```ts
const usdt = await ethers.getContractAt("BridgeUSDT", USDT_ADDRESS);
await usdt.mint(user.address, ethers.parseUnits("100", 18));
```

## مرجع سریع توابع

| تابع | Visibility | Mutability | دسترسی | هدف |
| --- | --- | --- | --- | --- |
| `mint(to,amount)` | external | nonpayable | MINTER_ROLE | ضرب برای انتقال ورودی |
| `mintBatch(recipients,amounts)` | external | nonpayable | MINTER_ROLE | ضرب گروهی |
| `adminBurn(from,amount)` | external | nonpayable | BURNER_ROLE | سوزاندن هر حساب بدون allowance |
| `pause()` / `unpause()` | external | nonpayable | PAUSER_ROLE | کلید فریز سراسری |
| `rescueERC20(token,to,amount)` | external | nonpayable | DEFAULT_ADMIN | جمع‌آوری توکن سرگردان |
| `decimals()` | public | view | همه | اعشار تنظیم‌شده |
| `burn(amount)` *(ارثی)* | public | nonpayable | دارنده | سوزاندن خودی |
| `burnFrom(from,amount)` *(ارثی)* | public | nonpayable | دارندهٔ allowance | سوزاندن مبتنی بر اجازه |
| `permit(...)` *(ارثی)* | external | nonpayable | دارندهٔ امضا | تأیید EIP-2612 |
| `supportsInterface(bytes4)` *(ارثی)* | public | view | همه | ERC-165 |
