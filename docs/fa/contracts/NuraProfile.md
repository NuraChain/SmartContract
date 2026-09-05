# NuraProfile

> نسخهٔ انگلیسی: [../../contracts/NuraProfile.md](../../contracts/NuraProfile.md) · راهنمای کامل طراحی: [`contracts/profile/README.md`](../../../contracts/profile/README.md)

## نمای کلی قرارداد

| ویژگی | مقدار |
| --- | --- |
| نام قرارداد | ‏`NuraProfile` (پشت `NuraProfileProxy`؛ مدل خواندن در `NuraProfileLens`) |
| فایل | ‏`contracts/profile/NuraProfile.sol` |
| نسخهٔ Solidity | ‏`^0.8.28`، کامپایل با **viaIR**، بهینه‌ساز ۲۰۰ اجرا، EVM ‏`cancun` |
| نوع قرارداد | تک‌نمونهٔ قابل ارتقا (UUPS) پشت پراکسی ERC-1967؛ ذخیره‌سازی فضای‌نام‌دار ERC-7201 |
| هدف | رجیستری پروفایل غیرمتمرکز برای اکوسیستم نورا: یک پروفایل به ازای هر آدرس، نام کاربری یکتای جهانی، فیلدهای کلید/مقدار چندزبانه، مجموعه‌های عمومی آیتم (وب‌سایت، تصویر، شبکهٔ اجتماعی و هر نوع آینده)، اپراتورهای تأییدشده توسط مالک، انتقال دو مرحله‌ای با آدرس بازیابی، و رجیستری افزونه‌هایی که در فضای‌نام خودشان می‌نویسند |
| اندازهٔ بایت‌کد | ‏۲۱٬۵۰۲ بایت (سقف EIP-170 برابر ۲۴٬۵۷۶؛ نوراچین دقیقاً اعمال می‌کند) |

## اصل طراحی

هستهٔ قرارداد **هیچ اسکیمایی ذخیره نمی‌کند.** هر مقدار با آدرس `(profile, key, language)` نگهداری
می‌شود و هر آیتم لیستی، کیسه‌ای از همین مقدارها زیر یک `kind` آزاد است. «اضافه‌کردن فیلد دیسکورد»
یک کلید است؛ «اضافه‌کردن ویترین NFT» یک kind است؛ «تأیید گیت‌هاب» یک قرارداد افزونه است که در
فضای‌نام خودش می‌نویسد. هیچ‌کدام به تغییر `NuraProfile.sol` نیاز ندارند.

```text
Profile #id
├── owner / username / createdAt / updatedAt / pendingOwner / recovery
├── fields         key → lang → string                 setField / setLocalizedField / setFields
├── items          itemId → {kind, index}              addItem / addWebsite / addImage / addSocial
│     └── attributes  itemId → key → lang → string      setItemAttribute(s)
│     └── itemIds     kind → uint32[]                   getItemIds (حذف با swap-and-pop)
└── extensionFields  extensionId → key → lang → string   فقط همان افزونه می‌نویسد
```

## وراثت

```text
NuraProfile
├── INuraProfile              -- سطح خارجی کامل + رویدادها
├── Initializable
├── Ownable2StepUpgradeable   -- ادمین قرارداد (ارتقا، رجیستری افزونه، رزرو نام کاربری)
├── UUPSUpgradeable           -- upgradeToAndCall؛ _authorizeUpgrade = onlyOwner
└── ERC165Upgradeable
```

## شناسه‌ها

کلیدها، kindها، برچسب زبان و نام کاربری به‌صورت `string` دریافت و پس از اعتبارسنجی به
`bytes32` (چپ‌چین، صفرپُر) تبدیل می‌شوند؛ همین شکل در storage و رویدادها استفاده می‌شود و در
اکسپلورر خوانا است.

| شناسه | قاعده |
| --- | --- |
| کلید فیلد/ویژگی | ۱ تا ۳۲ بایت ASCII چاپ‌شدنی بدون فاصله (0x21..0x7E)؛ حروف حفظ می‌شود |
| kind آیتم | ۱ تا ۲۸ بایت با همان الفبا |
| برچسب زبان | خالی = پیش‌فرض؛ وگرنه ۱ تا ۳۲ بایت از `[A-Za-z0-9-]` که **به حروف کوچک** تبدیل می‌شود (`pt-BR` = `pt-br`) |
| نام کاربری | ۳ تا ۳۲ بایت؛ حروف لاتین به کوچک تبدیل؛ فقط `[a-z0-9_]`؛ نباید با `0x` شروع شود |
| مقدار | حداکثر ۴۰۹۶ بایت؛ مقدار خالی = حذف |

## چندزبانگی

هر فیلد و هر ویژگی آیتم یک مقدار پیش‌فرض (زبان `""`) و هر تعداد مقدار محلی دارد. لیست زبان
پشتیبانی‌شده وجود ندارد؛ هر برچسبی که با الفبا بخواند معتبر است.

```solidity
profile.setField(id, "bio", "Blockchain developer building Nura Chain");
profile.setLocalizedField(id, "bio", "fa", "توسعه‌دهنده بلاکچین و سازنده Nura Chain");
profile.resolveField(id, "bio", "fa");   // مقدار فارسی
profile.resolveField(id, "bio", "fr");   // برمی‌گردد به پیش‌فرض
lens.getProfile(owner, "fa");            // همهٔ فیلدهای استاندارد به فارسی با fallback
```

## رویدادها

| رویداد | پارامترها (ایندکس‌شده با *) | محرک |
| --- | --- | --- |
| ‏`ProfileCreated` / `ProfileDeleted` | ‏`profileId*, owner*, username*` | ساخت / حذف |
| ‏`ProfileUpdated` | ‏`profileId*` | هر تغییر محتوا (برای نامعتبرکردن کش) |
| ‏`ProfileTransferInitiated` / `ProfileTransferCancelled` / `ProfileTransferred` | ‏`profileId*, from*, to*` | چرخهٔ انتقال |
| ‏`RecoveryAddressSet` / `OperatorSet` | ‏`profileId*, recovery*` / `owner*, operator*, approved` | مجوزها |
| ‏`UsernameChanged` / `UsernameReserved` / `UsernameUnreserved` | ‏`profileId*, previous*, new*` / … | نام کاربری |
| ‏`FieldUpdated` / `LocalizedFieldUpdated` / `FieldRemoved` | ‏`profileId*, key*, [lang*], value` | فیلدها |
| ‏`ItemAdded` / `ItemRemoved` | ‏`profileId*, itemId*, kind*` | هر افزودن/حذف آیتم (تایپ‌دار یا عمومی) |
| ‏`ItemAttributeUpdated` / `ItemAttributeRemoved` | ‏`profileId*, itemId*, key*, lang, value` | مسیر عمومی ویژگی |
| ‏`WebsiteAdded/Updated/Removed`، `ImageAdded/Updated/Removed`، `SocialAdded/Updated/Removed` | با payload خودشان | توابع تایپ‌دار |
| ‏`ExtensionAdded/Removed`، `ExtensionApprovalSet`، `ExtensionFieldUpdated/Removed` | … | افزونه‌ها |

یک ایندکسر می‌تواند کل وضعیت را از همین رویدادها بازسازی کند؛ تست «indexer compatibility» در
`test/Profile.test.ts` دقیقاً همین کار را می‌کند و نتیجه را با lens مقایسه می‌کند.

## خطاها (سطح فایل، در ABI)

‏`ProfileNotFound`، `AlreadyHasProfile`، `NotAuthorized`، `NotProfileOwner`، `NotOwnerOrRecovery`،
‏`NotPendingOwner`، `NoPendingTransfer`، `ZeroAddress`، `InvalidAddress`، `InvalidUsername`،
‏`UsernameTaken`، `UsernameIsReserved`، `UsernameUnchanged`، `InvalidKey`، `InvalidKind`،
‏`InvalidLanguage`، `ValueTooLong`، `ItemNotFound`، `ItemKindMismatch`،
‏`ExtensionAlreadyRegistered`، `ExtensionNotRegistered`، `ExtensionNotApproved`،
‏`InvalidExtension`، `ExtensionIdMismatch` + خطاهای OpenZeppelin.

## توابع

### دسته‌بندی

- **چرخهٔ پروفایل:** ‏`createProfile`، `deleteProfile`، `transferProfile`، `acceptProfile`،
  ‏`cancelTransfer`، `setRecoveryAddress`، `setOperator`
- **نام کاربری:** ‏`setUsername`؛ ادمین: `reserveUsername`، `unreserveUsername`
- **فیلدها:** ‏`setField`، `setLocalizedField`، `setFields`، `removeField`
- **آیتم عمومی:** ‏`addItem`، `setItemAttribute`، `setItemAttributes`، `removeItem`
- **آیتم تایپ‌دار:** ‏`add/update/removeWebsite`، `add/update/removeImage`، `add/update/removeSocial`
- **افزونه‌ها:** ادمین `registerExtension`، `unregisterExtension`؛ مالک `approveExtension`؛
  افزونه `setExtensionField`؛ افزونه/مالک/اپراتور `removeExtensionField`
- **ادمین:** ‏`initialize` (یک‌بار، در سازندهٔ پراکسی)، `upgradeToAndCall`، مالکیت دو مرحله‌ای
- **نماهای هسته:** ‏`profileIdOf`، `ownerOf`، `exists`، `isAuthorized`، `getProfileRecord`،
  ‏`usernameOf`، `resolveUsername`، `isUsernameAvailable`، `normalizeUsername`، `getField`،
  ‏`getLocalizedField`، `resolveField`، `resolveFields`، `getItemIds`، `getItemCount`،
  ‏`getItemKind`، `getItemAttribute`، `resolveItemAttribute(s)`، `getExtension(s)`،
  ‏`isExtensionApproved`، `getExtensionField`
- **نماهای lens:** ‏`getProfile(address, lang)`، `getProfileById`، `getProfileByUsername`،
  ‏`getFullProfile`، `getWebsites`، `getImages`، `getSocials`، `getItems(kind, keys, offset, limit)`

هر نوشتن، پروفایل را با `profileId` مشخص می‌کند (از `profileIdOf(address)`)، تا اپراتورها و
حساب‌های هوشمند بتوانند بدون این‌که خودِ آدرس باشند روی پروفایل عمل کنند.

### جدول دسترسی

| عمل | مالک | اپراتور | آدرس بازیابی | ادمین |
| --- | --- | --- | --- | --- |
| ویرایش فیلد/آیتم/ویژگی | ✔ | ✔ | ✖ | ✖ |
| حذف فیلد یک افزونه از پروفایل من | ✔ | ✔ | ✖ | ✖ |
| نام کاربری، تأیید افزونه، آدرس بازیابی، اپراتور | ✔ | ✖ | ✖ | ✖ |
| شروع/لغو انتقال | ✔ | ✖ | ✔ | ✖ |
| پذیرش انتقال | فقط مالک در انتظار | | | |
| حذف پروفایل | ✔ | ✖ | ✖ | ✖ |
| ارتقا، رجیستری افزونه، رزرو نام | ✖ | ✖ | ✖ | ✔ |

**ادمین به هیچ محتوایی دسترسی ندارد.** تست‌ها تأیید می‌کنند همهٔ توابع محتوا و هویت، مالک
قرارداد را رد می‌کنند.

### نکات مهم رفتار

- **انتقال دو مرحله‌ای:** ‏`transferProfile(id, to)` سپس `acceptProfile(id)` از سوی `to` که نباید
  پروفایل داشته باشد. پس از پذیرش، آدرس بازیابی پاک می‌شود (انتخاب مالک قبلی بود).
- **حذف پروفایل** نام کاربری و آدرس را آزاد می‌کند و id را بازنشسته می‌کند. رشته‌های فیلد و آیتم پاک
  نمی‌شوند (حلقهٔ نامحدود می‌شد) اما چون id هرگز دوباره استفاده نمی‌شود و همهٔ getterها با
  `ProfileNotFound` برمی‌گردند، از طریق API غیرقابل‌دسترس‌اند.
- **حذف آیتم** با swap-and-pop انجام می‌شود؛ ترتیب لیست تا اولین حذف، ترتیب درج است. ویژگی‌های
  آیتم حذف‌شده با `ItemNotFound` غیرقابل‌خواندن می‌شوند.
- **افزونه‌ها** فقط در فضای‌نام خودشان می‌نویسند، فقط پس از تأیید مالکِ همان پروفایل، و هسته
  هرگز آن‌ها را صدا نمی‌زند (بدون hook → بدون DoS یا reentrancy از مسیر افزونه).
- **رزرو نام کاربری** فقط بر ثبت‌های آینده اثر دارد؛ نامی که الان در اختیار کاربر است هرگز پس گرفته
  نمی‌شود. مقابله با جعل هویت از راه نشان‌های تأیید (افزونهٔ `SocialVerifier`) است، نه لغو.

## مدل امنیتی

- سه سطح مجوز (`_requireAuthorized`، `_requireOwner`، `_requireOwnerOrRecovery`) که همه `owner`
  را از storage می‌خوانند و فقط `msg.sender` را می‌سنجند.
- بدون دریافت کوین بومی، بدون انتقال توکن، بدون فراخوانی خارجی در مسیر کاربر؛ تنها فراخوانی‌های
  بیرونی، handshake ‏ERC-165 در `registerExtension` (فقط ادمین، همه `view`) است.
- ایمنی ارتقا: پیاده‌سازی با `_disableInitializers` قفل است؛ `onlyProxy`؛ بررسی `proxiableUUID`؛
  فضای‌نام ERC-7201 (فقط افزودن به انتهای `Layout`)؛ مالکیت ادمین دو مرحله‌ای.
- شناسه‌ها ASCII با تبدیل حروف؛ مقدارها بایت‌های خام هستند و فرانت‌اند باید آن‌ها را escape کند و
  scheme لینک‌ها را بررسی کند. هیچ‌چیز روی زنجیره URL یا CID را واکشی نمی‌کند.
- ممیزی نشده. مالک قرارداد باید پشت یک مولتی‌سیگ باشد.

## گس

از `npm run gas:profile` (viaIR، ۲۰۰ اجرا): ساخت پروفایل با نام کاربری ۱۴۷k؛ با سه فیلد ۲۰۸k؛
فیلد کوتاه ۶۳k سرد / ۴۶k گرم؛ فیلد محلی ۶۴k؛ وب‌سایت ۱۷۶k اول / ۱۲۵k بعدی؛ تصویر ۱۸۴k؛ شبکهٔ
اجتماعی ۱۸۳k؛ آیتم عمومی با دو ویژگی ۲۱۷k؛ تغییر نام ۷۰k؛ پذیرش انتقال ۶۴k؛ حذف ۴۵k. جدول کامل در
README گروه.

## استقرار

‏`ignition/modules/profile.ts` (‏`npm run deploy:nurachain:profile`) پیاده‌سازی، پراکسیِ
مقداردهی‌شده با `owner`، lens و `SocialVerifier` را مستقر می‌کند؛ ‏`scripts/profile-setup.ts`
افزونهٔ تأیید را ثبت می‌کند (عمل مالک)؛ ‏`scripts/profile-upgrade.ts` ارتقای UUPS را انجام و
تأیید می‌کند. پارامترها: `owner`، `verifierAdmin`، `verifierSigner` (پیش‌فرض: deployer).

مستقرشده روی نوراچین (chain id 1020) در تاریخ 2026-09-05:

| قرارداد | آدرس |
| --- | --- |
| ‏`NuraProfileProxy` (آدرس رجیستری؛ با ABI ‏`NuraProfile` استفاده شود) | ‏`0x8CFbcEf737BE3C67A52A20Ae3DCC685ACF759460` |
| پیاده‌سازی `NuraProfile` نسخهٔ 1.0.0 (پشت پراکسی) | ‏`0x8ff69542387343fe8a9e053779f23058fBbA7f71` |
| ‏`NuraProfileLens` | ‏`0xE8BD8Fc19907274b3CF87Bd72F4cd92Ca3c62F05` |
| ‏`SocialVerifier` | ‏`0xc81bF5e81a9aB9447eeE873b916538750f3161D8` |
