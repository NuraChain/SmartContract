# WNURA

> نسخهٔ انگلیسی: [../../contracts/WNURA.md](../../contracts/WNURA.md)

## نمای کلی قرارداد

| ویژگی | مقدار |
| --- | --- |
| نام قرارداد | `WNURA` |
| فایل سولیدیتی | `contracts/testing/WNURA.sol` |
| نسخهٔ سولیدیتی | ‏`=0.6.6` (پین‌شده؛ کامپایل با solc 0.6.6، istanbul) |
| نوع قرارداد | قرارداد wrapped-native سازگار با ERC20 |
| هدف | کوین بومی پیچیده‌شده: با deposit ضرب، با withdraw باز می‌شود. برای periphery یونی‌سواپ V3 لازم است و به‌عنوان fixture تست هم کاربرد دارد |
| مجوز | GPL-3.0 (تبار Dapphub WETH9، تغییرنام‌یافته) |

آپ‌استریم آن را WETH9 می‌نامد (فورک‌های BNB:‏ WBNB)؛ اینجا یک‌بار دیگر به WNURA تغییر
نام داده تا کیف پول‌ها «WNURA» نشان دهند. دیپلوی canonical روی زنجیره از جابه‌جایی این
فایل قدیمی‌تر است و بی‌تأثیر. توجه: برخلاف WETH9 اصلی، fallback قابل‌پرداخت در این نسخه
کامنت شده — wrap کردن فقط با فراخوانی صریح `deposit()` ممکن است.

## متغیرهای State

| متغیر | نوع | هدف |
| --- | --- | --- |
| `name` / `symbol` / `decimals` | string/string/uint8 | ‏"Wrapped NURA" / "WNURA" / 18 |
| `balanceOf` | mapping(address => uint256) | کلید: دارنده ← موجودی پیچیده‌شده |
| `allowance` | mapping(address => mapping(address => uint256)) | کلیدها: مالک ← خرج‌کننده ← اجازه |

## رویدادها

سه‌گانهٔ استاندارد: ‏`Deposit(dst, wad)` (indexed dst)، ‏`Withdrawal(src, wad)` (indexed src)
و ERC20 ‏`Transfer(src,dst,wad)` / `Approval(src,guy,wad)`.

## توابع

### deposit

```solidity
function deposit() public payable;
```

به اندازهٔ msg.value برای فراخواننده ضرب می‌کند و `Deposit` صادر می‌کند. برای همه.

### withdraw

```solidity
function withdraw(uint wad) public;
```

سوزاندن wad و بازکردن با `msg.sender.transfer(wad)` (سقف گاز ۲۳۰۰ — قراردادهای با receive
سنگین شکست می‌خورند؛ در تست‌های روترِ V3 مستند شده). موجودی ناکافی revert با رشتهٔ خالی.

### totalSupply

برابر `address(this).balance` — عرضه همیشه = بومیِ پیچیده‌شده.

### approve

اجازهٔ مطلق به سبک داپ‌هاب (`allowance[owner][guy] = wad`)؛ true برمی‌گرداند.

### transfer / transferFrom

معناشناسی داپ‌هاب: allowance برابر `uint(-1)` بی‌نهایت تلقی و کسر نمی‌شود؛ غیر از آن کسر
می‌شود. چک موجودی با رشتهٔ خالی revert می‌شود. هر دو bool برمی‌گردانند.

## تحلیل امنیتی

- **الگوهای قدیمی به‌عمد:** پرداخت با `.transfer`، allowance بی‌نهایت بدون کسر، رشته‌های
  خطای خالی، ریاضی پیش از 0.8. این وفاداری به رفتار WETH9 برای سازگاری با زیرساخت
  دیپلوی‌شده و هارنس‌های تست V3 است.
- **مشکلی دیده نشد** برای نقش مورد نظر (wrapped-native / مقصد روتر)؛ آن را ERC20 مدرن OZ
  فرض نکنید.

## اطلاعات دیپلوی

- آدرس canonical روی Nurachain: ‏`0xf0a4eC07916feBa4432121Ed5969887D9b939cD0`
  (در `web/application/src/config/contracts.ts` ثبت شده و مقدار پیش‌فرض `wnura` در
  `ignition/modules/univ3.ts` است).
- دیپلوی محلی/تست: ‏`ethers.deployContract("WNURA")`.

## راهنمای یکپارچه‌سازی

wrap: ‏`deposit{value:x}()`؛ unwrap: ‏`withdraw(x)`؛ مسیریابی با
`approve/transfer/transferFrom`. گوش دهید به `Deposit`, `Withdrawal`, `Transfer`.
