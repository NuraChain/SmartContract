# FeeMath (کتابخانه)

> نسخهٔ انگلیسی: [../../contracts/FeeMath.md](../../contracts/FeeMath.md)

## نمای کلی

| ویژگی | مقدار |
| --- | --- |
| نام | `FeeMath` |
| فایل | `contracts/forecast/libraries/FeeMath.sol` |
| نسخه | ‏0.8.24 |
| نوع | ‏`library` (internal pure) |
| هدف | ابزارهای کارمزد بیس‌پوینت مشترک buy/sell؛ کارمزد هر معامله به «سهم پروتکل» (به خزانه) و «سهم LP» (به‌عنوان نقدینگی اضافه در استخر می‌ماند و ارزش سهام LP را بالا می‌برد) تفکیک می‌شود |

## ثابت‌ها

| نام | نوع | مقدار | هدف |
| --- | --- | --- | --- |
| `BPS` | uint256 internal constant | ‏1e4 | مخرج بیس‌پوینت (۱۰۰٪). کران بالای اعتبارسنجی `protocolFeeShareBps`. |

## توابع

### feeOnAmount

```solidity
feeOnAmount(amount, feeBps) -> fee    // fee = amount·feeBps/1e4 (floor)
```

کارمزد روی **ورودی ناخالص خرید**. مصرف‌کنندگان: ‏`buy`, `calcBuy`.

### grossFromNet

```solidity
grossFromNet(net, feeBps) -> gross    // gross = ceil(net·1e4/(1e4−feeBps))
```

وثیقه‌ای که فروش باید از استخر بکشد تا فروشنده `net` دریافت کند؛ به بالا گرد می‌شود تا
کارمزد هرگز کم‌برآورد نشود. مصرف‌کنندگان: ‏`sell`, `calcSell`.

### protocolCut

```solidity
protocolCut(fee, protocolShareBps) -> cut   // cut = fee·share/1e4 (floor)
```

سهم خزانه؛ باقیمانده مال LPها. توسط موتور استخر پاری‌موچل نادیده گرفته می‌شود.

## تحلیل امنیتی

- گرد کردن همیشه به سلامت کارمزد کمک می‌کند (کارمزد هرگز کم‌برآورد نمی‌شود).
- ریاضی checked سولیدیتی 0.8؛ تقسیم بر صفر در `grossFromNet` فقط با `feeBps == 1e4`
  ممکن بود که سازنده‌ها `feeBps ≤ 1000` را الزام کرده‌اند.
- **مشکلی دیده نشد.**

## مرجع سریع

| تابع | دید | Mutability | هدف |
| --- | --- | --- | --- |
| `feeOnAmount(amount,bps)` | internal | pure | کارمزد ورودی خرید |
| `grossFromNet(net,bps)` | internal | pure | مبلغ فروش ناخالص |
| `protocolCut(fee,shareBps)` | internal | pure | سهم خزانه |
