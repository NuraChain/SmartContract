# Akıllı Sözleşme Sistemi — Genel Bakış

> **English:** [`docs/contracts/README.md`](../../contracts/README.md) · **فارسی:** [`docs/fa/contracts/README.md`](../../fa/contracts/README.md)
> Her sözleşmenin ayrıntılı dokümantasyonu (fonksiyonlar, olaylar, hatalar, güvenlik) İngilizce olarak `docs/contracts/` içindedir.

Depodaki tüm sözleşmelerin belgeleri, `contracts/` altındaki gerçek kaynaktan üretildi. Her birinci taraf sözleşmenin eksiksiz İngilizce dosyası vardır; bu sayfa tüm sistemin özetidir.

## Sözleşme dizini

| Sözleşme | Dosya | Tür |
| --- | --- | --- |
| `BridgeToken` | contracts/token/BridgeToken.so­l | soyut ERC20 tabanı |
| `BridgeUSDT` / `BridgeBNB` | token/*.sol | köprü tokenları (18 ondalık) |
| `Airdrop` | airdrop/Airdrop.sol | EIP-712 imzalı yerel coin dağıtımı |
| `CollateralizedNFT` | vault/CollateralizedNFT.sol | tek bir ERC20 ile desteklenen ERC721 kasa |
| `PredictionFactory` | forecast/PredictionFactory.sol | klon fabrikası + kayıt defteri |
| `PredictionMarket` | forecast/PredictionMarket.sol | CPMM tahmin piyasası (ERC-1155) |
| `PredictionPool` | forecast/PredictionPool.sol | parimütüel piyasa |
| `PredictionTreasury` | forecast/PredictionTreasury.sol | komisyon hazinesi |
| `NuraProfile` | profile/NuraProfile.sol | profil kaydı (UUPS): benzersiz kullanıcı adı, çok dilli alanlar, uzantılar |
| `FeeMath` / `MarketMath` | forecast/libraries | matematik kütüphaneleri |
| `WNURA` | testing/WNURA.sol | sarmalanmış yerel coin (WETH9) |
| `MockToken` | testing/MockToken.sol | test tokeni |
| Uniswap V3 (vendored) | contracts/univ3 | grup düzeyinde belgelenmiş üçüncü taraf ağacı |

Arayüzler (`IPredictionFactory`, `IPredictionMarket`, `IPredictionPool`,
`IPredictionTreasury`, `IBackingToken`) ve paylaşılan tipler İngilizce sürümde kendi sözleşmeleri içinde belgelenmiştir.

## Çekirdek mimari

```text
   BridgeUSDT/BridgeBNB          PredictionFactory ──createMarket──▶ CollateralizedNFT
        ▲                             │        └─createMarket2▶ EIP-1167 klonu
        │ mint/adminBurn              │ clones                       │
   users ◀── Transfer ──── PredictionMarket   PredictionPool         │
                                   ▼                  ▼                 ▼
                            CPMM alım-satım/bahis  bahis/talep ──▶ Treasury
```

### İki tahmin motoru

İkisi de aynı fabrikada kayıtlıdır; yaşam-döngüsü durumlarını, hazineyi ve olay yüzeyini paylaşır:

| | ‏PredictionMarket (‏createMarket) | ‏PredictionPool (‏createMarket2) |
| --- | --- | --- |
| Model | Sanal rezervler üzerinde sabit çarpım AMM | parimütüel havuz |
| Araçlar | ERC-1155 payları + LP payları | doğrudan bahis muhasebesi |
| Başlangıç likiditesi | gerekli (payable oluşturma) | yok (eklenen değer reddedilir) |
| Erken çözüm | lockTime'dan **önce** mümkün (güven varsayımı) | imkânsız — ‏`LockNotReached` |
| Komisyonlar | işlem başına protokol/LP bölüşümü | çözümde tek seferlik ev sahibi komisyonu |

## Yetki modeli

| Sözleşme | Roller | Kritik yetkiler |
| --- | --- | --- |
| Köprü tokenları | DEFAULT_ADMIN/MINTER/BURNER/PAUSER | karşılıksız mint, el koyma yanması, genel duraklatma, kurtarma |
| Airdrop | DEFAULT_ADMIN/PAUSER/SIGNER | boşaltma, yeniden fiyatlama, duraklatma; imzalayan uygunluğu belirler |
| Vault | DEFAULT_ADMIN/MINTER + herkese açık mint anahtarı | gelecekteki kilim miktarı, ücretsiz-mint yarışını açmak, yalnızca **boşta kısmı** çekmek |
| Forecast fabrikası | ADMIN_ROLE | piyasa oluşturmak (komisyon ≤ %10), hepsini çözmek/geçersiz kılmak, hazineyi yönlendirmek |
| Piyasalar | controller'larına (fabrika) güvenir | yaşam döngüsü yalnızca fabrika rölesi üzerinden |
| Hazine | Ownable2Step sahibi | tüm komisyonları çekmek, alıcıyı değiştirmek |

Her Ignition modülü varsayılan olarak admin rolünü dağıtana verir — gerçek değer akmadan multisig'e taşıyın.

## Ana kullanıcı akışları

```text
CPMM işlemi:  buy{value}(i,minOut,deadline) ─▶ fee ─▶ Treasury ; MarketResolved(w) sonrası: redeem()
Pool bahsi:   bet{value}(i) lockTime'a kadar ─▶ admin resolve ─▶ claim() oransal
Köprü:        relay girişte mint yapar; BURNER çıkışta yakar
Vault:        deposit ─▶ mint NFT (lockAmount rezervi) ── redeem sahibine öder
Airdrop:      backend Claim(account,deadline) imzalar ─▶ getReward() ─▶ yerel ödeme
```

## Kayıtlı dağıtım bilgileri

| Sözleşme | Ağ | Adres |
| --- | --- | --- |
| BridgeUSDT | Nurachain 1020 | 0x4E0DB0B1Da408faF5637202CF48b0bc7733bE6dC |
| BridgeBNB | Nurachain 1020 | 0xD4221Ad9772BF5bA7423a044bBBEe6af2154A5Fc |
| WNURA | Nurachain 1020 | 0xf0a4eC07916feBa4432121Ed5969887D9b939cD0 |
| Multicall3 | Nurachain 1020 | 0xf58884FCf45d8F5Cc8A73c618D23EB27b732CA24 |
| PredictionFactory | Nurachain 1020 | 0x33fE315c8a7FeA10152dD2b21B5d87936aF9B79d |
| PredictionMarket (uygulama; piyasalar klondur) | Nurachain 1020 | 0x4b94c8F32Ff506D31d79d21D94eC1d8AE3d1F145 |
| PredictionPool (uygulama; havuzlar klondur) | Nurachain 1020 | 0x675b24758B199c3A5674f0288dfdeaA217fB2A86 |
| PredictionTreasury | Nurachain 1020 | 0xDABEDD148F5AE5f3e130aB811a8975828Ea75AA8 |
| NuraProfileProxy (profil kaydı — `NuraProfile` ABI ile) | Nurachain 1020 | 0x8CFbcEf737BE3C67A52A20Ae3DCC685ACF759460 |
| NuraProfile (proxy arkasındaki uygulama 1.0.0) | Nurachain 1020 | 0x8ff69542387343fe8a9e053779f23058fBbA7f71 |
| NuraProfileLens | Nurachain 1020 | 0xE8BD8Fc19907274b3CF87Bd72F4cd92Ca3c62F05 |
| SocialVerifier | Nurachain 1020 | 0xc81bF5e81a9aB9447eeE873b916538750f3161D8 |
| diğerleri | Nurachain 1020 | Depoda bulunamadı — dağıtımda kaydedilir |

## Bütünsel güvenlik

- Profil kaydı dışında hiçbir yerde proxy/yükseltme yok: `NuraProfile`, ERC-1967 proxy arkasında UUPS'tir, yalnızca iki adımlı sahibi yükseltebilir ve yöneticinin kullanıcı içeriğine erişimi yoktur. Diğer tüm sözleşmelerin davranışı dağıtımda kesinleşir.
- Klon uygulamaları `_disableInitializers()` çağırır; başlatma, oluşturmayla atomiktir.
- Para yolları checks-effects-interactions + storage tabanlı reentrancy kilitleri kullanır.
- Yuvarlama her zaman havuzlar/hazine lehinedir.
- Kalıcı risk merkeziyetsizlik değil merkezileşmedir: çözüm, mint, duraklatma ve boşaltma yönetici anahtarlarına dayanır.

```text
Documentation completed.  (sistem özeti Türkçe; eksiksiz referans İngilizce)

Missing documentation:    0
```
