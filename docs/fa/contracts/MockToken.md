# MockToken

> نسخهٔ انگلیسی: [../../contracts/MockToken.md](../../contracts/MockToken.md)

## نمای کلی قرارداد

| ویژگی | مقدار |
| --- | --- |
| نام قرارداد | `MockToken` |
| فایل سولیدیتی | `contracts/testing/MockToken.sol` |
| نسخهٔ سولیدیتی | ‏`^0.8.20` (کامپایل با solc 0.8.28) |
| نوع قرارداد | توکن ERC20 توسعه/تست |
| هدف | جایگزین dev-chain برای دارایی واقعی (سبک mUSDT/mUSDC/mDAI/mWBTC)؛ توسط مجموعه تست یونی‌سواپ V3 استفاده می‌شود |
| مجوز | MIT |

**جزء هیچ گروه دیپلوی نیست** — دارایی ماک فقط وسایل تست‌نت است.

## وراثت

```text
MockToken
└── ERC20 (OpenZeppelin)
```

## متغیرهای State

| متغیر | نوع | دید | تغییرپذیری | هدف |
| --- | --- | --- | --- | --- |
| `_tokenDecimals` | uint8 | private | immutable | اعشار قابل تنظیم که `decimals()` overrideشده برمی‌گرداند. |
| `deployer` | address | public | immutable | تنها ذی‌نفع mint نامحدود. |
| `faucetEnabled` | bool | public | immutable | وجود یا عدم وجود شیر عمومی. دیپلوی‌های mainnet باید false بدهند. |

## سازنده

```solidity
constructor(string name_, string symbol_, uint8 decimals_, bool faucetEnabled_)
    ERC20(name_, symbol_)
```

## توابع

### faucet

```solidity
function faucet(uint256 amount) external;
```

خودضربی تا سقف `100_000 * 10^decimals` در هر فراخوانی وقتی `faucetEnabled`.
revert با `'MockToken: faucet disabled'` / `'MockToken: faucet cap'`. برای همه (وقتی فعال).

### mint

```solidity
function mint(address to, uint256 amount) external;
```

mint نامحدود فقط برای `deployer` (`'MockToken: not deployer'`) — seed کردن نقدینگی.

به‌علاوه سطح کامل ERC20 اوپن‌زللین.

## تحلیل امنیتی

مدل اعتماد مخصوص تست: شیر فعال یعنی هر کس می‌تواند عرضه را دلخواه متورم کند.
هرگز ارزش واقعی به MockToken وصل نکنید.

## اطلاعات دیپلوی

به‌صورت ad hoc توسط تست‌ها (`test/univ3/helpers.ts`). ماژول Ignition ندارد. آدرس: ناموجود.

## مرجع سریع توابع

| تابع | Visibility | Mutability | دسترسی | هدف |
| --- | --- | --- | --- | --- |
| `faucet(amount)` | external | nonpayable | همه اگر فعال | خودضربی سقف‌دار |
| `mint(to,amount)` | external | nonpayable | Deployer | seed نامحدود |
| `decimals()` | public | view | همه | اعشار تنظیم‌شده |
