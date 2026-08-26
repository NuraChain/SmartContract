# نظام العقود الذكية — نظرة عامة

> **English:** [`docs/contracts/README.md`](../../contracts/README.md) · **فارسی:** [`docs/fa/contracts/README.md`](../../fa/contracts/README.md)
> الوثائق التفصيلية لكل عقد (الدوال، الأحداث، الأخطاء، الأمان) متوفرة بالإنجليزية في `docs/contracts/`.

توثيق لكل عقود هذا المستودع، مُولَّد من الشيفرة المصدرية الفعلية تحت `contracts/`.
العقود من الطرف الأول لكل منها ملف مستقل بالإنجليزية؛ هذه الصفحة ملخص شامل للنظام كله.

## فهرس العقود

| العقد | الملف | النوع |
| --- | --- | --- |
| `BridgeToken` | ‏contracts/token/BridgeToken.sol | أساس ERC20 مجرّد (abstract) |
| `BridgeUSDT` / `BridgeBNB` | token/*.sol | رموز ممثلة للجسر (18 رقمًا عشريًا) |
| `Airdrop` | airdrop/Airdrop.sol | توزيع عملة أصلية موقّع بـ EIP-712 |
| `CollateralizedNFT` | vault/CollateralizedNFT.sol | خزنة NFT مدعومة بـ ERC20 |
| `PredictionFactory` | forecast/PredictionFactory.sol | مصنع استنساخ + سجل |
| `PredictionMarket` | forecast/PredictionMarket.sol | سوق تنبؤ CPMM (‏ERC-1155) |
| `PredictionPool` | forecast/PredictionPool.sol | سوق تنبؤ باريموتيول |
| `PredictionTreasury` | forecast/PredictionTreasury.sol | خزانة الرسوم |
| `FeeMath` / `MarketMath` | forecast/libraries | مكتبات رياضية |
| `WNURA` | testing/WNURA.sol | العملة الأصلية المغلّفة (WETH9) |
| `MockToken` | testing/MockToken.sol | رمز تجريبي للاختبار |
| Uniswap V3 (مُورَّد) | contracts/univ3 | شجرة طرف ثالث موثقة كمجموعة |

الواجهات (`IPredictionFactory`, `IPredictionMarket`, `IPredictionPool`,
`IPredictionTreasury`, `IBackingToken`) والأنواع المشتركة (`MarketKind`, `MarketStatus`,
`MarketParams`, `MarketRecord`) موثقة داخل عقودها في النسخة الإنجليزية.

## البنية الأساسية

```text
   BridgeUSDT/BridgeBNB          PredictionFactory ──createMarket──▶ CollateralizedNFT
        ▲                             │        └─createMarket2▶ EIP-1167 clone
        │ mint/adminBurn              │ clones                    │
   users ◀── Transfer ──── PredictionMarket   PredictionPool       │
                                   ▼                  ▼               │
                            CPMM trading/bets     betting/claims         │
                                   ▼                                       ▼
                          PredictionTreasury ──withdraw──▶ feeRecipient
```

### محركا التنبؤ

كلاهما مسجل في سجل واحد ويشتركان في حالات الدورة الحياتية والخزينة وسطح الأحداث:

| | ‏PredictionMarket (‏createMarket) | ‏PredictionPool (‏createMarket2) |
| --- | --- | --- |
| النموذج | AMM بمنتج ثابت على احتياطيات افتراضية | مجمّع باريموتيول |
| الأدوات | حصص ERC-1155 + حصص مزوّدي السيولة | محاسبة رهانات مباشرة |
| سيولة أولية | مطلوبة (إنشاء payable) | لا شيء (رفض القيمة المرفقة) |
| الحل المبكر | ممكن **قبل** lockTime (فرض ثقة) | مستحيل — ‏`LockNotReached` |
| الرسوم | تقسيم بروتوكول/LP لكل صفقة | رسم منزل واحد عند الحل |

## نموذج الصلاحيات

| العقد | الأدوار | صلاحيات حرجة |
| --- | --- | --- |
| رموز الجسر | DEFAULT_ADMIN/MINTER/BURNER/PAUSER | ضرب بلا دعم، إحراق مصادَر، إيقاف شامل، إنقاذ |
| Airdrop | DEFAULT_ADMIN/PAUSER/SIGNER | تصفية، إعادة تسعير، إيقاف؛ الموقّع يحدد الاستحقاق |
| الخزنة (Vault) | DEFAULT_ADMIN/MINTER + مفتاح السك العام | حجم قفل المستقبل، فتح سباق السك المجاني، سحب **الجزء الحر فقط** |
| مصنع Forecast | ADMIN_ROLE | إنشاء الأسواق (رسوم ≤ 10%)، حل/إبطال كل سوق، تغيير الخزينة |
| الأسواق | تثق بـ controller (المصنع) | دورة الحياة عبر رلي المصنع فقط |
| Treasury | مالك Ownable2Step | سحب كل الرسوم، تغيير المستلم |

تمنح كل وحدة نشر Ignition أدوار المسؤول للمُنشر افتراضيًا — انقلها إلى multisig قبل أي قيمة حقيقية.

## تدفقات المستخدم الرئيسية

```text
تداول CPMM:  buy{value}(i,minOut,deadline) ─▶ رسوم ─▶ Treasury ؛ بعد MarketResolved(w): redeem()
رهان Pool:   bet{value}(i) حتى lockTime ─▶ حل الأدمين ─▶ claim() تناسبيًا للفائزين
الجسر:       الرلّي يضرب عند الإيداع؛ BURNER يحرق عند الخروج
Vault:       deposit ─▶ mint NFT (يحجز lockAmount) ─▶ redeem يدفع للمالك
التوزيع:     الخادم يوقّع Claim(account,deadline) ─▶ getReward() ─▶ دفع أصلي
```

## معلومات النشر المسجلة

| العقد | الشبكة | العنوان |
| --- | --- | --- |
| BridgeUSDT | Nurachain 1020 | ‏0x4E0DB0B1Da408faF5637202CF48b0bc7733bE6dC |
| BridgeBNB | Nurachain 1020 | ‏0xD4221Ad9772BF5bA7423a044bBBEe6af2154A5Fc |
| WNURA | Nurachain 1020 | ‏0xf0a4eC07916feBa4432121Ed5969887D9b939cD0 |
| Multicall3 | Nurachain 1020 | ‏0xf58884FCf45d8F5Cc8A73c618D23EB27b732CA24 |
| الباقي | Nurachain 1020 | غير موجود في المستودع — يُسجَّل وقت النشر |

## الأمان الشامل

- لا بروكسيات ولا ترقيات في أي مكان؛ السلوك يتحدد عند النشر.
- تطبيقات الاستنساخ تستدعي `_disableInitializers()` والتهيئة ذرّية مع الإنشاء.
- مسارات الأموال تتبع checks-effects-interactions مع أقفال reentrancy قائمة على التخزين.
- التقريب دائمًا لمصلحة المجمعات/الخزينة.
- الخطر الدائم هو المركزية: الحل والسك والإيقاف والتصفية كلها تعود لمفاتيح الأدمن.

```text
Documentation completed.  (ملخص النظام بالعربية؛ المرجع الكامل بالإنجليزية)

Missing documentation:    0
```
