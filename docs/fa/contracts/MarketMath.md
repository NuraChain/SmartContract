# MarketMath (کتابخانه)

> نسخهٔ انگلیسی: [../../contracts/MarketMath.md](../../contracts/MarketMath.md)

## نمای کلی

| ویژگی | مقدار |
| --- | --- |
| نام | `MarketMath` |
| فایل | `contracts/forecast/libraries/MarketMath.sol` |
| نسخه | ‏0.8.24 |
| نوع | ‏`library` (توابع internal — در زمان کامپایل inline می‌شوند؛ هرگز دیپلوی نمی‌شود) |
| هدف | ریاضیات معامله و قیمت‌گذاری FPMM روی آرایهٔ رزروهای هر خروجی |

ناوردای توان ثابت: ‏`∏ r_j = k`. چون فرمول‌ها حاصل‌ضرب/نسبتی‌اند فقط به
`Math.mulDiv` اوپن‌زللین نیاز است — بدون log/exp یا کتابخانهٔ ممیز ثابت.
**سیاست گرد کردن:** خرید سهام را floor می‌کند و فروش ورودی لازم را ceil؛ هر دو به نفع
استخر، پس گرد کردن هرگز maker را تخلیه نمی‌کند.

## متغیرها

ندارد. یک ثابت داخلی:

| نام | مقدار | هدف |
| --- | --- | --- |
| `WAD` | ‏1e18 | مقیاس ممیز ثابت برای قیمت‌های گزارشی |

## توابع

همگی `internal pure` روی `uint256[] memory reserves`:

### calcBuyShares

```solidity
calcBuyShares(reserves, outcomeIndex, investment) -> sharesOut
```

سهامی که با وثیقهٔ خالص `investment` ضرب می‌شود:
‏`endReserve = r_i · ∏_{j≠i} r_j/(r_j + investment)` (floor با mulDiv)؛
‏`sharesOut = r_i + investment − endReserve`. گرد شدن به نفع استخر.

### calcSellShares

```solidity
calcSellShares(reserves, outcomeIndex, grossFromPool) -> sharesIn
```

توکنِ لازم برای بیرون کشیدن `grossFromPool` وثیقه:
‏`endReserve = r_i · ∏_{j≠i} r_j/(r_j − gross)` با **گرد کردن به بالا**؛
‏`sharesIn = endReserve + gross − r_i`.
اگر رزرو دیگری ≤ gross باشد [`InsufficientLiquidity`] revert می‌شود. مصرف‌کننده:
`sell`/`calcSell` در PredictionMarket.

### prices

```solidity
prices(reserves) -> uint256[] memory
```

قیمت‌های نهایی در WAD: ‏`p_i = (1e36/r_i) / Σ_k (1e36/r_k)` — از طریق معکوس‌ها محاسبه
می‌شود تا هیچ حاصل‌ضرب رزروها شکل نگیرد (برای هر n ایمن نسبت به overflow). رزرو صفر ⇒ سهم ۰.
مصرف‌کننده: ‏`getPrices()`.

### maxReserve

بزرگ‌ترین رزرو؛ مصرف‌کننده: ریاضی نقدینگی تناسبیِ `addFunding`.

## تحلیل امنیتی

- **دقت:** همهٔ تقسیم‌ها با `Math.mulDiv` (بدون overflow میانی) و جهتِ گرد صریح در هر طرف معامله.
- **مشکلی دیده نشد:** توابع pure بدون state و تماس خارجی.
- فراخواننده باید اندیس را اعتبارسنجی کند (`calcBuyShares` خودش bound check ندارد؛
  `_requireTradable` در PredictionMarket تضمینش می‌کند).

## مرجع سریع

| تابع | دید | Mutability | هدف |
| --- | --- | --- | --- |
| `calcBuyShares(reserves,i,in)` | internal | pure | کوت خرید (floor) |
| `calcSellShares(reserves,i,gross)` | internal | pure | کوت فروش (ceil) |
| `prices(reserves)` | internal | pure | قیمت‌های WAD |
| `maxReserve(reserves)` | internal | pure | بزرگ‌ترین رزرو |
