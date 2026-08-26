# Airdrop (ایردراپ)

> نسخهٔ انگلیسی: [../../contracts/Airdrop.md](../../contracts/Airdrop.md)

## نمای کلی قرارداد

| ویژگی | مقدار |
| --- | --- |
| نام قرارداد | `Airdrop` |
| فایل سولیدیتی | `contracts/airdrop/Airdrop.sol` |
| نسخهٔ سولیدیتی | `^0.8.28` (solc 0.8.28، cancun) |
| نوع قرارداد | مستقل و واقعی (دیپلوی با constructor) |
| هدف | پرداخت مبلغ ثابتی از **کوین بومی** به نخستین `maxClaims` آدرسِ واجد شرایط؛ هر آدرس فقط یک بار |
| ارتقاءپذیر / پروکسی | خیر / خیر |
| مجوز | MIT |

واجد شرایط بودن کاملاً خارج از زنجیره اثبات می‌شود: کلید بک‌اندی که `SIGNER_ROLE` دارد
پیام EIP-712 با ساختار `Claim(account, deadline)` را امضا می‌کند. بدون آن، «هر آدرس یک
بار» بی‌ارزش است چون هر کس می‌تواند بی‌نهایت آدرس بسازد. چک‌های on-chain فقط مانع ادعای
تکراری و عبور از سقف می‌شوند.

قرارداد از **موجودی بومی خودش** پرداخت می‌کند و پیش از شروع باید حداقل
`maxClaims × rewardAmount` فاند شود (با `fund()` یا انتقال ساده).

## وراثت

```text
Airdrop
├── AccessControl    -- نقش‌های DEFAULT_ADMIN، PAUSER، SIGNER
├── Pausable         -- توقف سراسری ادعا
├── ReentrancyGuard  -- محافظ مسیرهای پرداخت getReward/withdraw
└── EIP712           -- دامنهٔ امضا («Airdrop», "1")؛ امضا را به این قرارداد + این زنجیره می‌بندد
```

## اینترفیس‌ها

اینترفیس خارجی مصرف نمی‌کند؛ پرداخت با `Address.sendValue` انجام می‌شود. بررسی امضا با
`ECDSA.tryRecover` است — یعنی فقط کلیدهای EOA می‌توانند SIGNER_ROLE را عملاً ایفا کنند.

## متغیرهای State

| متغیر | نوع | دید | تغییرپذیری | هدف |
| --- | --- | --- | --- | --- |
| `SIGNER_ROLE` | `bytes32` | public | constant | نقشی که مجاز به امضای صلاحیت است. |
| `PAUSER_ROLE` | `bytes32` | public | constant | نقش توقف/ادامهٔ ادعا. |
| `CLAIM_TYPEHASH` | `bytes32` | private | constant | ‏`keccak256("Claim(address account,uint256 deadline)")`. |
| `maxClaims` | `uint256` | public | **immutable** | سقف سخت تعداد ادعاها؛ immutable تا وعده بعداً بزرگ نشود. |
| `rewardAmount` | `uint256` | public | mutable | پاداش هر ادعا به wei (ادمین قابل تغییر، فقط برای ادعاهای بعدی). |
| `totalClaims` | `uint256` | public | mutable | تعداد ادعاهای انجام‌شده؛ همزمان شمارهٔ ردیف ادعای بعدی. |
| `hasClaimed` | `mapping(address => bool)` | public | mutable | کلید: آدرس → آیا ادعا کرده؟ برای همیشه یک ادعا. |

## Structs / Enumها

ندارد.

## ثابت‌ها

جدول بالا (`CLAIM_TYPEHASH`). دامنهٔ EIP-712: نام `"Airdrop"`، نسخه `"1"` به‌همراه
chainId و verifyingContract.

## Modifierها

| Modifier | منبع | شرط | جلوگیری از | استفاده در |
| --- | --- | --- | --- | --- |
| `onlyRole(role)` | AccessControl | دارندهٔ نقش | فراخوانی غیرمجاز | `setRewardAmount`, `pause`, `unpause`, `withdraw` |
| `whenNotPaused` | Pausable | عدم توقف | ادعا در زمان فریز | `getReward` |
| `nonReentrant` | ReentrancyGuard | آزاد بودن قفل | reentrancy در پرداخت | `getReward`, `withdraw` |

## رویدادها

| رویداد | پارامترها | Indexed | محل صدور |
| --- | --- | --- | --- |
| `RewardClaimed` | `account, amount, claimNumber` | `account` | `getReward` موفق؛ `claimNumber` شمارنده (از ۱) |
| `RewardAmountUpdated` | `previousAmount, newAmount` | ندارد | `setRewardAmount` |
| `Funded` | `from, amount` | `from` | `fund()` یا هر انتقال ساده (`receive`) |
| `Withdrawn` | `to, amount` | ندارد | برداشت ادمین |

## خطاها

| خطا | شرط وقوع | مسیر | اجتناب |
| --- | --- | --- | --- |
| `ZeroAddress()` | صفر بودن admin/signer در سازنده؛ مقصد صفر withdraw | سازنده، `withdraw` | آدرس واقعی |
| `ZeroAmount()` | سقف/پاداش صفر در سازنده؛ value صفر در fund؛ `setRewardAmount(0)`؛ withdraw صفر | سازنده، `fund`، `setRewardAmount`، `withdraw` | مقادیر مثبت |
| `AlreadyClaimed(account)` | `hasClaimed[msg.sender]` | `getReward` | هر آدرس فقط یک بار |
| `AirdropFull(maxClaims)` | `totalClaims >= maxClaims` | `getReward` | هیچ — سقف immutable است |
| `SignatureExpired(deadline)` | `block.timestamp > deadline` | `getReward` | امضای تازه |
| `InvalidSignature()` | شکست recover یا نبودن نقش SIGNER برای بازیابی‌شده | `getReward` | امضای صحیح توسط بک‌اند |
| `InsufficientBalance(available, required)` | موجودی کمتر از پاداش/مبلغ | `getReward`, `withdraw` | ابتدا فاند کنید |

## توابع

### طبقه‌بندی

- **کاربر:** `getReward`
- **مالی:** `getReward` (پرداخت)، `fund` (دریافت)، `withdraw` (برگرداندن)، `receive`
- **مدیریتی:** `setRewardAmount`, `pause`, `unpause`, `withdraw`
- **View:** `remainingClaims`, `fundedClaims`, `outstandingLiability`, `claimDigest`
- **Callback:**‏ `receive()`

---

### getReward

```solidity
function getReward(uint256 deadline, bytes calldata signature)
    external nonReentrant whenNotPaused;
```

**هدف:** دریافت سهم این آدرس از ایردراپ. `account` همیشه `msg.sender` است (به نام دیگران
نمی‌شود ادعا کرد).

**جریان اجرا:**
۱. مهلت امضا چک می‌شود → `SignatureExpired`.
۲. ادعای قبلی → `AlreadyClaimed`.
۳. پر بودن سقف → `AirdropFull`.
۴. digest = `_hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, account, deadline)))`.
۵. `ECDSA.tryRecover(digest, signature)`؛ خطا یا نبود نقش SIGNER → `InvalidSignature`.
۶. خواندن `rewardAmount` و چک موجودی → `InsufficientBalance`.
۷. **ابتدا effects:**‏ `hasClaimed=true`، افزایش `totalClaims`، صدور `RewardClaimed`.
۸. **بعد تعامل:** ‏`Address.sendValue(payable(account), amount)`.

**امنیت:** ترتیب CEI + ‏`nonReentrant`؛ امضا با دامنهٔ EIP-712 به قرارداد/زنجیره بسته
است (replay بین دیپلوی‌ها ممکن نیست)؛ s غیرکاننیکی رد می‌شود (OZ ECDSA).

---

### remainingClaims / fundedClaims / outstandingLiability

```solidity
remainingClaims()      // maxClaims - totalClaims
fundedClaims()        // موجودی / rewardAmount
outstandingLiability() // remaining × rewardAmount
```

داشبورد خواندنی برای همه. مقایسهٔ دو دومی وضعیت زیرفاند بودن را نشان می‌دهد.

---

### claimDigest

```solidity
function claimDigest(address account, uint256 deadline) external view returns (bytes32);
```

دقیقاً همان digeste که بک‌اند باید امضا کند — برای حذف تکرار منطق دامنه در بک‌اند/تست‌ها.

---

### setRewardAmount

```solidity
function setRewardAmount(uint256 newAmount) external; // DEFAULT_ADMIN_ROLE
```

پاداش ادعاهای **بعدی** را عوض می‌کند؛ ادعاکنندگان قبلی دست‌نخورده‌اند.
رویداد قبل از نوشتن state صادر می‌شود. صفر → `ZeroAmount`.

---

### pause / unpause

توقف/ادامهٔ `getReward` از طریق `Pausable` با نقش PAUSER_ROLE.

---

### fund / receive

```solidity
function fund() external payable;   // value صفر → ZeroAmount
receive() external payable;         // انتقال ساده را هم می‌پذیرد
```

هر دو استخر را شارژ و `Funded(sender, msg.value)` صادر می‌کنند. برای همه.

---

### withdraw

```solidity
function withdraw(address to, uint256 amount) external; // DEFAULT_ADMIN_ROLE
```

ارسال `amount` کوین بومی به `to` با `Address.sendValue`. چک‌ها: آدرس/مقدار غیرصفر و
کافی بودن موجودی. رویداد **قبل از** ارسال (CEI + nonReentrant).

**امنیت:** ادمین می‌تواند کل استخر را تخلیه کند — مسیر بازیابی عمدی، اما لو رفتن کلید =
سرقت استخر.

## کنترل دسترسی

| تابع | نقش لازم | چه کسی |
| --- | --- | --- |
| `getReward` | امضای معتبر SIGNER_ROLE | هر آدرس واجد شرایط |
| `fund`، `receive` | ندارد | همه |
| `setRewardAmount` | `DEFAULT_ADMIN_ROLE` | ادمین |
| `pause`/`unpause` | `PAUSER_ROLE` | pauser |
| `withdraw` | `DEFAULT_ADMIN_ROLE` | ادمین |

**اختیارات CRITICAL:**‏ `withdraw` (تخلیه)، `setRewardAmount` (قیمت‌گذاری مجدد)،
`pause` (توقف). کلید SIGNER تعیین‌کنندهٔ لیست است — کلید Signer باید جدا از ماشین دیپلوی
نگه داشته شود.

## جریان مالی

```text
خزانه ──fund()/انتقال──▶ موجودی Airdrop
                              │
کاربر ──getReward(deadline,sig)──┤ چک‌ها: pause؟ claimed؟ سقف؟ امضا؟
   ▲                            │
   └── sendValue(reward) ◀──────┘
مازاد: DEFAULT_ADMIN ──withdraw──▶ مقصد دلخواه
```

بدون نیاز به approval (کوین بومی). بازگشت خودکار وجود ندارد؛ مازاد تا withdraw می‌ماند.

## تحلیل امنیتی

| حوزه | نتیجه |
| --- | --- |
| Reentrancy | **مشکلی دیده نشد** — CEI + nonReentrant + sendValue (بدون callback گاز-محدود) |
| Replay امضا بین زنجیره‌ها/دیپلوی‌ها | **مشکلی ندارد** — دامنهٔ EIP-712 شامل chainId و آدرس |
| Malleability امضا | **ندارد** — s کانونیک الزامی |
| دور زدن سقف | **ملاحظهٔ طراحی** — سقف immutable؛ اما ادمین می‌تواند پاداش را کم کند تا استخر بیشتر دوام بیاورد (نه بیشتر) |
| تمرکز | **ریسک بالقوه** — سه کلید EOA جدا مگر multisig شوند |
| DoS | گاز کاربر خودش؛ حلقه روی کاربران نیست |
| Front-running | ادعا به‌دلیل یکتایی آدرس frontrun سودمند ندارد |

## اطلاعات دیپلوی

- شبکه: Nurachain (1020). آدرس: Not found in repository (فقط هنگام دیپلوی ثبت می‌شود).
- دیپلوی: `npm run deploy:nurachain:airdrop` — برای `--max-claims` و `--reward`
  می‌پرسد (هر دو immutable یا پول‌شکل‌اند و پیش‌فرض ندارند).

## راهنمای یکپارچه‌سازی

جریان بک‌اند:
۱. `digest = await airdrop.claimDigest(userAddress, deadline)`.
۲. امضا با کلید SIGNER_ROLE — حتماً **EIP-712 typed data**
   (`signer.signTypedData`) نه `signMessage`.
۳. `{deadline, signature}` به کاربر بدهید؛ کاربر `getReward` می‌زند.

گوش دهید به: `RewardClaimed`، `Funded`، `Withdrawn`، `RewardAmountUpdated`.
خطاهای رایج: انقضای deadline (امضای تازه)، `AlreadyClaimed`، `AirdropFull`، استخر خالی.

## مرجع سریع توابع

| تابع | Visibility | Mutability | دسترسی | هدف |
| --- | --- | --- | --- | --- |
| `getReward(deadline,sig)` | external | nonpayable | امضای معتبر | ادعای یک‌باره |
| `remainingClaims()` | external | view | همه | ادعاهای باقی‌مانده تا سقف |
| `fundedClaims()` | external | view | همه | ادعاهای قابل‌پرداخت الان |
| `outstandingLiability()` | external | view | همه | بدهی کامل ادعاهای باقی‌مانده |
| `claimDigest(account,deadline)` | external | view | همه | digest دقیق EIP-712 |
| `setRewardAmount(new)` | external | nonpayable | DEFAULT_ADMIN | قیمت جدید ادعاهای آینده |
| `pause()/unpause()` | external | nonpayable | PAUSER_ROLE | توقف/ادامه |
| `fund()` | external | payable | همه | شارژ استخر |
| `withdraw(to,amount)` | external | nonpayable | DEFAULT_ADMIN | بازیافت کوین |
| `receive()` | external | payable | همه | پذیرش شارژ ساده |
