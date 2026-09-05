# Система смарт-контрактов — Обзор

> **English:** [`docs/contracts/README.md`](../../contracts/README.md) · **فارسی:** [`docs/fa/contracts/README.md`](../../fa/contracts/README.md)
> Подробная документация по каждому контракту (функции, события, ошибки, безопасность) доступна на английском в `docs/contracts/`.

Документация по всем контрактам репозитория, созданная на основе фактического исходного кода в `contracts/`. Для каждого собственного контракта есть полный файл на английском; эта страница — сводка всей системы.

## Индекс контрактов

| Контракт | Файл | Тип |
| --- | --- | --- |
| `BridgeToken` | contracts/token/BridgeToken.sol | абстрактная база ERC20 |
| `BridgeUSDT` / `BridgeBNB` | token/*.sol | мостовые токены (18 знаков) |
| `Airdrop` | airdrop/Airdrop.sol | раздача нативной монеты с подписью EIP-712 |
| `CollateralizedNFT` | vault/CollateralizedNFT.sol | хранилище ERC721 под обеспечением ERC20 |
| `PredictionFactory` | forecast/PredictionFactory.sol | фабрика клонов + реестр |
| `PredictionMarket` | forecast/PredictionMarket.sol | рынок предсказаний CPMM (ERC-1155) |
| `PredictionPool` | forecast/PredictionPool.sol | пари-мютуэль рынок |
| `PredictionTreasury` | forecast/PredictionTreasury.sol | казначейство комиссий |
| `NuraProfile` | profile/NuraProfile.sol | реестр профилей (UUPS): уникальные имена, многоязычные поля, расширения |
| `FeeMath` / `MarketMath` | forecast/libraries | математические библиотеки |
| `WNURA` | testing/WNURA.sol | обёртка нативной монеты (WETH9) |
| `MockToken` | testing/MockToken.sol | тестовый токен |
| Uniswap V3 (vendored) | contracts/univ3 | стороннее дерево, описано на уровне группы |

Интерфейсы (`IPredictionFactory`, `IPredictionMarket`, `IPredictionPool`,
`IPredictionTreasury`, `IBackingToken`) и общие типы задокументированы в английской версии внутри соответствующих контрактов.

## Основная архитектура

```text
   BridgeUSDT/BridgeBNB          PredictionFactory ──createMarket──▶ CollateralizedNFT
        ▲                             │        └─createMarket2▶ клон EIP-1167
        │ mint/adminBurn              │ clones                       │
   users ◀── Transfer ──── PredictionMarket   PredictionPool         │
                                   ▼                  ▼                 ▼
                            торговля CPMM/ставки  ставки/claims ─▶ Treasury
```

### Два движка предсказаний

Оба регистрируются в одной фабрике и разделяют статусы жизненного цикла, казначейство и поверхность событий:

| | ‏PredictionMarket (‏createMarket) | ‏PredictionPool (‏createMarket2) |
| --- | --- | --- |
| Модель | AMM постоянного произведения на виртуальных резервах | пул пари-мютуэль |
| Инструменты | доли ERC-1155 + доли LP | прямой учёт ставок |
| Начальная ликвидность | требуется (payable создание) | отсутствует (прикреплённое значение отклоняется) |
| Досрочное разрешение | возможно **до** lockTime (предположение доверия) | невозможно — ‏`LockNotReached` |
| Комиссии | разделение протокол/LP с каждой сделки | единая комиссия при разрешении |

## Модель разрешений

| Контракт | Роли | Критичные полномочия |
| --- | --- | --- |
| Мостовые токены | DEFAULT_ADMIN/MINTER/BURNER/PAUSER | эмиссия без обеспечения, конфискационное сжигание, глобальная пауза, спасение |
| Airdrop | DEFAULT_ADMIN/PAUSER/SIGNER | опустошение, переоценка, пауза; подписант определяет право на получение |
| Vault | DEFAULT_ADMIN/MINTER + переключатель публичного минта | будущий размер блокировки, открыть гонку бесплатного минта, вывод **только свободной части** |
| Фабрика Forecast | ADMIN_ROLE | создание рынков (комиссия ≤ 10%), разрешение/аннулирование всех, перенаправление казначейств |
| Рынки | доверяют controller (фабрика) | жизненный цикл только через релей фабрики |
| Казначейство | владелец Ownable2Step | вывод всех комиссий, смена получателя |

Каждый модуль Ignition по умолчанию выдаёт роль администратора деплойеру — переведите их на multisig до реальных средств.

## Основные пользовательские сценарии

```text
Торговля CPMM: buy{value}(i,minOut,deadline) ─▶ fee ─▶ Treasury ; после MarketResolved(w): redeem()
Ставка Pool:   bet{value}(i) до lockTime ─▶ resolve админом ─▶ claim() пропорционально
Мост:          релей минтит на входе; BURNER сжигает на выходе
Vault:         deposit ─▶ mint NFT (резерв lockAmount) ── redeem платит владельцу
Airdrop:       бэкенд подписывает Claim(account,deadline) ─▶ getReward() ─▶ нативная выплата
```

## Записанные данные деплоя

| Контракт | Сеть | Адрес |
| --- | --- | --- |
| BridgeUSDT | Nurachain 1020 | 0x4E0DB0B1Da408faF5637202CF48b0bc7733bE6dC |
| BridgeBNB | Nurachain 1020 | 0xD4221Ad9772BF5bA7423a044bBBEe6af2154A5Fc |
| WNURA | Nurachain 1020 | 0xf0a4eC07916feBa4432121Ed5969887D9b939cD0 |
| Multicall3 | Nurachain 1020 | 0xf58884FCf45d8F5Cc8A73c618D23EB27b732CA24 |
| PredictionFactory | Nurachain 1020 | 0x33fE315c8a7FeA10152dD2b21B5d87936aF9B79d |
| PredictionMarket (реализация; рынки — клоны) | Nurachain 1020 | 0x4b94c8F32Ff506D31d79d21D94eC1d8AE3d1F145 |
| PredictionPool (реализация; пулы — клоны) | Nurachain 1020 | 0x675b24758B199c3A5674f0288dfdeaA217fB2A86 |
| PredictionTreasury | Nurachain 1020 | 0xDABEDD148F5AE5f3e130aB811a8975828Ea75AA8 |
| NuraProfileProxy (реестр профилей — использовать ABI `NuraProfile`) | Nurachain 1020 | 0x8CFbcEf737BE3C67A52A20Ae3DCC685ACF759460 |
| NuraProfile (реализация 1.0.0 за прокси) | Nurachain 1020 | 0x8ff69542387343fe8a9e053779f23058fBbA7f71 |
| NuraProfileLens | Nurachain 1020 | 0xE8BD8Fc19907274b3CF87Bd72F4cd92Ca3c62F05 |
| SocialVerifier | Nurachain 1020 | 0xc81bF5e81a9aB9447eeE873b916538750f3161D8 |
| остальные | Nurachain 1020 | Не найдено в репозитории — фиксируется при деплое |

## Сквозной уровень безопасности

- Прокси и обновлений нет нигде, кроме реестра профилей: `NuraProfile` — UUPS за прокси ERC-1967, обновлять может только его двухэтапный владелец, и у администратора нет доступа к данным пользователей. Поведение остальных контрактов фиксируется при деплое.
- Реализации клонов вызывают `_disableInitializers()`; инициализация атомарна с созданием.
- Денежные пути следуют checks-effects-interactions со storage-блокировками от реентерабельности.
- Округление всегда в пользу пулов/казначейства.
- Постоянный риск — централизация: разрешение, эмиссия, пауза и слив сведены к ключам администратора.

```text
Documentation completed.  (обзор системы на русском; полная справка на английском)

Missing documentation:    0
```
