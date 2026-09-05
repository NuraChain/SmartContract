# Système de Smart Contracts — Vue d'ensemble

> **English:** [`docs/contracts/README.md`](../../contracts/README.md) · **فارسی:** [`docs/fa/contracts/README.md`](../../fa/contracts/README.md)
> La documentation détaillée de chaque contrat (fonctions, événements, erreurs, sécurité) est disponible en anglais dans `docs/contracts/`.

Documentation de tous les contrats du dépôt, générée à partir du code source réel sous `contracts/`. Chaque contrat interne possède un fichier complet en anglais ; cette page résume l'ensemble du système.

## Index des contrats

| Contrat | Fichier | Type |
| --- | --- | --- |
| `BridgeToken` | contracts/token/BridgeToken.sol | base ERC20 abstraite |
| `BridgeUSDT` / `BridgeBNB` | token/*.sol | jetons de pont (18 décimales) |
| `Airdrop` | airdrop/Airdrop.sol | distribution de pièce native signée EIP-712 |
| `CollateralizedNFT` | vault/CollateralizedNFT.sol | coffre ERC721 adossé à un ERC20 |
| `PredictionFactory` | forecast/PredictionFactory.sol | fabrique de clones + registre |
| `PredictionMarket` | forecast/PredictionMarket.sol | marché de prédiction CPMM (ERC-1155) |
| `PredictionPool` | forecast/PredictionPool.sol | marché parimutuel |
| `PredictionTreasury` | forecast/PredictionTreasury.sol | trésorerie des frais |
| `NuraProfile` | profile/NuraProfile.sol | registre de profils (UUPS) : nom unique, champs multilingues, extensions |
| `FeeMath` / `MarketMath` | forecast/libraries | bibliothèques mathématiques |
| `WNURA` | testing/WNURA.sol | natif enveloppé (WETH9) |
| `MockToken` | testing/MockToken.sol | jeton de test |
| Uniswap V3 (vendored) | contracts/univ3 | arborescence tierce documentée au niveau du groupe |

Les interfaces (`IPredictionFactory`, `IPredictionMarket`, `IPredictionPool`,
`IPredictionTreasury`, `IBackingToken`) et les types partagés sont documentés dans la version anglaise, au sein de leurs contrats.

## Architecture centrale

```text
   BridgeUSDT/BridgeBNB          PredictionFactory ──createMarket──▶ CollateralizedNFT
        ▲                             │        └─createMarket2▶ clone EIP-1167
        │ mint/adminBurn              │ clones                       │
   users ◀── Transfer ──── PredictionMarket   PredictionPool         │
                                   ▼                  ▼                 ▼
                            trading CPMM/paris    paris/claims ──▶ Treasury
```

### Les deux moteurs de prédiction

Tous deux sont enregistrés dans la même fabrique et partagent les statuts du cycle de vie, la trésorerie et la surface d'événements :

| | ‏PredictionMarket (‏createMarket) | ‏PredictionPool (‏createMarket2) |
| --- | --- | --- |
| Modèle | AMM à produit constant sur réserves virtuelles | cagnotte parimutuelle |
| Instruments | parts ERC-1155 + parts LP | comptabilité directe des paris |
| Liquidité initiale | requise (création payable) | aucune (valeur jointe refusée) |
| Résolution anticipée | possible **avant** lockTime (hypothèse de confiance) | impossible — ‏`LockNotReached` |
| Frais | partage protocole/LP par transaction | un seul frais prélevé à la résolution |

## Modèle de permissions

| Contrat | Rôles | Pouvoirs critiques |
| --- | --- | --- |
| Jetons de pont | DEFAULT_ADMIN/MINTER/BURNER/PAUSER | frappe sans garantie, brûlure confiscatoire, pause globale, sauvetage |
| Airdrop | DEFAULT_ADMIN/PAUSER/SIGNER | vidage, revalorisation, pause ; le signataire détermine l'éligibilité |
| Vault | DEFAULT_ADMIN/MINTER + interrupteur de mint public | taille future du verrou, ouvrir la course au mint gratuit, retrait de la **seule partie libre** |
| Fabrique Forecast | ADMIN_ROLE | créer des marchés (frais ≤ 10 %), résoudre/annuler tous les marchés, rediriger les trésoreries |
| Marchés | font confiance à leur controller (la fabrique) | cycle de vie uniquement via le relais de la fabrique |
| Trésorerie | propriétaire Ownable2Step | retirer tous les frais, changer le bénéficiaire |

Chaque module Ignition accorde le rôle admin au déployeur par défaut — migrez-les vers un multisig avant tout flux de valeur réel.

## Flux utilisateurs principaux

```text
Trader CPMM :  buy{value}(i,minOut,deadline) ─▶ frais ─▶ Treasury ; après MarketResolved(w) : redeem()
Parier Pool :  bet{value}(i) jusqu'à lockTime ─▶ resolve par l'admin ─▶ claim() proportionnel
Pont :         le relayer frappe à l'entrée ; BURNER brûle à la sortie
Vault :        deposit ─▶ mint NFT (réserve lockAmount) ── redeem paie le propriétaire
Airdrop :      le backend signe Claim(account,deadline) ─▶ getReward() ─▶ paiement natif
```

## Informations de déploiement enregistrées

| Contrat | Réseau | Adresse |
| --- | --- | --- |
| BridgeUSDT | Nurachain 1020 | 0x4E0DB0B1Da408faF5637202CF48b0bc7733bE6dC |
| BridgeBNB | Nurachain 1020 | 0xD4221Ad9772BF5bA7423a044bBBEe6af2154A5Fc |
| WNURA | Nurachain 1020 | 0xf0a4eC07916feBa4432121Ed5969887D9b939cD0 |
| Multicall3 | Nurachain 1020 | 0xf58884FCf45d8F5Cc8A73c618D23EB27b732CA24 |
| autres | Nurachain 1020 | Introuvable dans le dépôt — consigné au déploiement |

## Sécurité transversale

- Aucun proxy ni mise à niveau nulle part ; le comportement est figé au déploiement.
- Les implémentations de clones appellent `_disableInitializers()` et l'initialisation est atomique avec la création.
- Les chemins monétaires suivent checks-effects-interactions avec verrous de réentrance en stockage.
- L'arrondi favorise toujours les cagnottes/trésorerie.
- Le risque permanent est la centralisation : résolution, frappe, pause et vidage se ramènent aux clés d'administration.

```text
Documentation completed.  (synthèse du système en français ; référence complète en anglais)

Missing documentation:    0
```
