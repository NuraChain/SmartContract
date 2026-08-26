# سیستم قراردادهای هوشمند — نمای کلی

> نسخهٔ انگلیسی: [../../contracts/README.md](../../contracts/README.md)

مستندسازی همهٔ قراردادهای این مخزن، تولیدشده از سورس واقعی زیر `contracts/`.
برای هر قرارداد first-party یک فایل مستقل؛ کتابخانه‌ها، ماک‌ها و کد وندور در فایل‌های
جدا پوشش داده شده‌اند.

## فهرست اسناد

| سند | قرارداد | فایل | نوع |
| --- | --- | --- | --- |
| [BridgeToken.md](BridgeToken.md) | ‏`BridgeToken` | ‏token/BridgeToken.sol | پایهٔ abstract ERC20 |
| [BridgeUSDT.md](BridgeUSDT.md) | ‏`BridgeUSDT` | token/BridgeUSDT.sol | توکن ERC20 |
| [BridgeBNB.md](BridgeBNB.md) | ‏`BridgeBNB` | token/BridgeBNB.sol | توکن ERC20 |
| [Airdrop.md](Airdrop.md) | ‏`Airdrop` | airdrop/Airdrop.sol | ایردراپ کوین بومی |
| [CollateralizedNFT.md](CollateralizedNFT.md) | ‏`CollateralizedNFT` | vault/CollateralizedNFT.sol | خزانهٔ ERC721 |
| [PredictionFactory.md](PredictionFactory.md) | ‏`PredictionFactory` | forecast/PredictionFactory.sol | کارخانهٔ کلون + رجیستری |
| [PredictionMarket.md](PredictionMarket.md) | ‏`PredictionMarket` | forecast/PredictionMarket.sol | بازار CPMM (ERC-1155) |
| [PredictionPool.md](PredictionPool.md) | ‏`PredictionPool` | forecast/PredictionPool.sol | بازار پاری‌موچل |
| [PredictionTreasury.md](PredictionTreasury.md) | ‏`PredictionTreasury` | forecast/PredictionTreasury.sol | مخزن کارمزد |
| [FeeMath.md](FeeMath.md) / [MarketMath.md](MarketMath.md) | کتابخانه‌ها | forecast/libraries | library |
| [WNURA.md](WNURA.md) | ‏`WNURA` | testing/WNURA.sol | wrapped-native |
| [MockToken.md](MockToken.md) | ‏`MockToken` | testing/MockToken.sol | توکن dev/test |
| [TestAndVendoredContracts.md](TestAndVendoredContracts.md) | ماک‌ها + یونی‌سواپ V3 | various | تستی/vendored |

اینترفیس‌ها (`IPredictionFactory`, `IPredictionMarket`, `IPredictionPool`,
`IPredictionTreasury`, `IBackingToken`) داخل بخش *Interfaces* قراردادهای پیاده‌ساز
مستند شده‌اند. انواع مشترک: ‏`PredictionTypes.sol` (‏`MarketKind`، ‏`MarketStatus`،
‏`MarketParams`، ‏`MarketRecord`)، ‏`PredictionErrors.sol` و `PredictionEvents.sol`
(اعلام سطح فایل — یک نقطهٔ اعلام، topicهای یکسان در همهٔ قراردادها).

## معماری هسته

```text
 گروه Bridge                    گروه Forecast                      گروه Vault
 ───────────                    ─────────────                      ──────────
 رله(minter/burner)             ADMIN_ROLE                         ادمین/minters
      │                               │                                  │
 BridgeUSDT/BridgeBNB        PredictionFactory ──createMarket──▶ CollateralizedNFT
      ▲                            │        └─createMarket2▶ کلون EIP-1167   ▲
      │ mint/adminBurn             │ ساخت کلون‌های EIP-1167      │             │ deposit/
      │                       PredictionMarket  PredictionPool   │             │ redeem
 کاربران ◀──────── Transfer ──────────│──────────────────│──────────┘            │
                                      ▼                  ▼                       │
                              معامله CPMM/شرط‌بندی    شرط‌بندی/claim                 │
                                      │ کارمزد پروتکل/خانه                توکن ERC20 پشتوانه
                                      ▼                                         │
                                PredictionTreasury ──withdraw──▶ feeRecipient ◀─┘
```

### دو موتور پیش‌بینی

هر دو در یک رجیستری ثبت می‌شوند و سطل وضعیت، لوله‌کشی خزانه و سطح رویداد مشترک دارند:

| | ‏createMarket ← PredictionMarket | createMarket2 ← PredictionPool |
| --- | --- | --- |
| مدل | AMM با توان ثابت روی رزروهای مجازی | استخر پاری‌موچل |
| ابزار | سهام ERC-1155 + سهام LP | حسابداری سادهٔ شرط |
| نقدینگی اولیه | لازم (payable) | ندارد (الصاق ارزش revert می‌شود) |
| حل زودهنگام | ممکن **قبل از** lockTime (فرض اعتماد) | ناممکن — ‏`LockNotReached` |
| کارمزد | تفکیک پروتکل/LP به‌ازای هر معامله | یک کارمزد خانه از کل استخر هنگام resolve |

## نمودار وابستگی

```text
PredictionFactory
├── Clones, AccessControl, EnumerableSet (OZ)
├── PredictionMarket (implementation، clone می‌شود)
│   ├── ERC1155Supply/Initializable (OZ upgradeable)
│   ├── MarketMath, FeeMath
│   ├── IPredictionTreasury ──▶ PredictionTreasury
│   └── PredictionTypes/Events/Errors
└── PredictionPool (implementation، clone می‌شود)
    ├── Initializable (OZ upgradeable)
    ├── FeeMath
    ├── IPredictionTreasury ──▶ PredictionTreasury
    └── PredictionTypes/Events/Errors

BridgeUSDT / BridgeBNB ──▶ BridgeToken ──▶ استک OZ ERC20
CollateralizedNFT ──▶ OZ ERC721 + AccessControl + ReentrancyGuard + SafeERC20 ──▶ IERC20 خارجی
Airdrop ──▶ OZ AccessControl + Pausable + ReentrancyGuard + EIP712 + ECDSA
WNURA (مستقل)، MockToken ──▶ OZ ERC20 (تست)
```

## مدل دسترسی (سراسری)

| قرارداد | نقش‌ها | اختیارات بحرانی |
| --- | --- | --- |
| توکن‌های پل | DEFAULT_ADMIN/MINTER/BURNER/PAUSER | ضرب بدون پشتوانه، سوزاندن مصادره‌ای، pause سراسری، sweep |
| Airdrop | DEFAULT_ADMIN/PAUSER/SIGNER | تخلیه، قیمت‌گذاری مجدد، توقف؛ signer تعیین صلاحیت |
| Vault | DEFAULT_ADMIN/MINTER + کلید ضرب عمومی | اندازهٔ قفل آینده، باز کردن مسابقهٔ mint رایگان، برداشت **فقط بخش آزاد** |
| کارخانهٔ Forecast | ADMIN_ROLE + مالک + امضاکننده‌های حل | ساخت بازار (کارمزد ≤ ۱۰٪)، void، تغییر خزانه‌ها؛ حل نیازمند حد نصاب N-از-M (مثلاً ۳ از ۵)؛ مالک می‌تواند مجموعه را عوض کند |
| بازارها | به controller (کارخانه) اعتماد دارند | چرخهٔ حیات فقط از طریق رلهٔ کارخانه |
| Treasury | مالک Ownable2Step | برداشت همهٔ کارمزدها، تغییر گیرنده |

سیم‌کشی دیپلوی: هر ماژول Ignition نقش ادمین را پیش‌فرض به دیپلوی‌کننده می‌دهد — پیش از
جریان ارزش واقعی به multisig منتقل شود.

## جریان‌های اصلی کاربر

```text
معامله در بازار CPMM:
  buy{value}(i,minOut,deadline) ─▶ cut ─▶ Treasury ؛ پس از MarketResolved(w): redeem()

شرط‌بندی در بازار استخر:
  bet{value}(i) تا lockTime ─▶ حد نصاب امضاکننده‌ها (مثلاً ۳ از ۵) confirmResolution می‌زند ─▶ claim() تناسبی برندگان

پل ورود/خروج:
  رله روی ورود mint می‌کند؛ BURNER روی خروج می‌سوزاند

Vault:
  deposit ERC20 ─▶ mint NFT (رزرو lockAmount) ─▶ owner با redeem پرداخت می‌گیرد

ایردراپ:
  بک‌اند Claim(account,deadline) را امضا می‌کند ─▶ getReward() ─▶ پرداخت بومی
```

## اطلاعات دیپلوی ثبت‌شده

| قرارداد | شبکه | آدرس |
| --- | --- | --- |
| BridgeUSDT | Nurachain 1020 | ‏0x4E0DB0B1Da408faF5637202CF48b0bc7733bE6dC |
| BridgeBNB | Nurachain 1020 | ‏0xD4221Ad9772BF5bA7423a044bBBEe6af2154A5Fc |
| WNURA | Nurachain 1020 | ‏0xf0a4eC07916feBa4432121Ed5969887D9b939cD0 |
| Multicall3 (زیرساخت زنجیره) | Nurachain 1020 | ‏0xf58884FCf45d8F5Cc8A73c618D23EB27b732CA24 |
| بقیه | Nurachain 1020 | Not found in repository — فقط هنگام دیپلوی ثبت می‌شود |

## امنیت سراسری

- هیچ‌جا پروکسی/ارتقاء وجود ندارد؛ رفتار هنگام دیپلوی قطعی می‌شود.
- پیاده‌سازی‌های کلون `_disableInitializers()` دارند و initialize هم‌تراکنش با ساخت است.
- مسیرهای پولی CEI + قفل reentrancy مبتنی بر storage.
- گرد کردن همیشه به نفع استخرها/خزانه است.
- ریسک ماندگار تمرکز است: حل، ضرب، توقف و تخلیه همگی به کلیدهای ادمین می‌رسند.

## گزارش راستی‌آزمایی

اسکن کامل `.sol`ها، اینترفیس‌ها، کتابخانه‌ها، ماک‌ها، ماژول‌های Ignition و ABIها انجام شد.
همهٔ واحدهای first-party مستند شدند؛ درخت Uniswap V3 در سطح گروه با ارجاع منشأ پوشش
داده شد.

```text
Documentation completed.  (نسخهٔ فارسی، ترجمهٔ وفادار از اسناد انگلیسی)

Missing documentation:    0
```
