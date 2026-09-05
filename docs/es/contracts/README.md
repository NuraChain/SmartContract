# Sistema de Contratos Inteligentes — Resumen

> **English:** [`docs/contracts/README.md`](../../contracts/README.md) · **فارسی:** [`docs/fa/contracts/README.md`](../../fa/contracts/README.md)
> La documentación detallada de cada contrato (funciones, eventos, errores, seguridad) está en inglés en `docs/contracts/`.

Documentación de todos los contratos del repositorio, generada del código fuente real bajo `contracts/`. Cada contrato propio tiene su archivo completo en inglés; esta página resume todo el sistema.

## Índice de contratos

| Contrato | Archivo | Tipo |
| --- | --- | --- |
| `BridgeToken` | contracts/token/BridgeToken.sol | base abstracta ERC20 |
| `BridgeUSDT` / `BridgeBNB` | token/*.sol | tokens puente (18 decimales) |
| `Airdrop` | airdrop/Airdrop.sol | reparto de moneda nativa firmado con EIP-712 |
| `CollateralizedNFT` | vault/CollateralizedNFT.sol | bóveda ERC721 respaldada por un ERC20 |
| `PredictionFactory` | forecast/PredictionFactory.sol | fábrica de clones + registro |
| `PredictionMarket` | forecast/PredictionMarket.sol | mercado de predicción CPMM (ERC-1155) |
| `PredictionPool` | forecast/PredictionPool.sol | mercado parimutual |
| `PredictionTreasury` | forecast/PredictionTreasury.sol | tesorería de comisiones |
| `NuraProfile` | profile/NuraProfile.sol | registro de perfiles (UUPS): usuario único, campos multilingües, extensiones |
| `FeeMath` / `MarketMath` | forecast/libraries | librerías matemáticas |
| `WNURA` | testing/WNURA.sol | nativo envuelto (WETH9) |
| `MockToken` | testing/MockToken.sol | token de prueba |
| Uniswap V3 (vendido) | contracts/univ3 | árbol de terceros documentado como grupo |

Las interfaces (`IPredictionFactory`, `IPredictionMarket`, `IPredictionPool`,
`IPredictionTreasury`, `IBackingToken`) y los tipos compartidos están documentados dentro de sus contratos en la versión inglesa.

## Arquitectura central

```text
   BridgeUSDT/BridgeBNB          PredictionFactory ──createMarket──▶ CollateralizedNFT
        ▲                             │        └─createMarket2▶ clon EIP-1167
        │ mint/adminBurn              │ clones                       │
   users ◀── Transfer ──── PredictionMarket   PredictionPool         │
                                   ▼                  ▼                 │
                            trading CPMM/apuestas  apuestas/reclamos      ▼
                          PredictionTreasury ──withdraw──▶ feeRecipient
```

### Los dos motores de predicción

Ambos se registran en la misma fábrica y comparten estados, tesorería y eventos:

| | ‏PredictionMarket (‏createMarket) | ‏PredictionPool (‏createMarket2) |
| --- | --- | --- |
| Modelo | AMM de producto constante sobre reservas virtuales | pozo parimutual |
| Instrumentos | participaciones ERC-1155 + LP | contabilidad directa de apuestas |
| Liquidez inicial | requerida (creación payable) | ninguna (rechaza valor adjunto) |
| Resolución anticipada | posible **antes** de lockTime (supuesto de confianza) | imposible — ‏`LockNotReached` |
| Comisiones | reparto protocolo/LP por operación | una sola comisión al resolver |

## Modelo de permisos

| Contrato | Roles | Poderes críticos |
| --- | --- | --- |
| Tokens puente | DEFAULT_ADMIN/MINTER/BURNER/PAUSER | acuñar sin respaldo, quemar arbitrario, pausa global, rescate |
| Airdrop | DEFAULT_ADMIN/PAUSER/SIGNER | drenar, reprecificar, pausar; el firmante decide la elegibilidad |
| Vault | DEFAULT_ADMIN/MINTER + interruptor de mint público | tamaño futuro del bloqueo, abrir mint libre, retirar **solo la parte libre** |
| Fábrica Forecast | ADMIN_ROLE | crear mercados (comisión ≤ 10 %), resolver/anular todos, redirigir tesoros |
| Mercados | confían en su controller (la fábrica) | ciclo de vida solo vía la fábrica |
| Tesorería | dueño Ownable2Step | retirar todas las comisiones, cambiar destinatario |

Cada módulo de Ignition otorga el rol admin al desplegador por defecto — muévelos a un multisig antes de valor real.

## Flujos principales de usuario

```text
Operar CPMM:  buy{value}(i,minOut,deadline) ─▶ fee ─▶ Treasury ; tras MarketResolved(w): redeem()
Apostar Pool: bet{value}(i) hasta lockTime ─▶ resolve del admin ─▶ claim() proporcional
Puente:       el relayer acuña en entrada; BURNER quema en salida
Vault:        deposit ─▶ mint NFT (reserva lockAmount) ── redeem paga al dueño
Airdrop:      el backend firma Claim(account,deadline) ─▶ getReward() ─▶ pago nativo
```

## Información de despliegue registrada

| Contrato | Red | Dirección |
| --- | --- | --- |
| BridgeUSDT | Nurachain 1020 | 0x4E0DB0B1Da408faF5637202CF48b0bc7733bE6dC |
| BridgeBNB | Nurachain 1020 | 0xD4221Ad9772BF5bA7423a044bBBEe6af2154A5Fc |
| WNURA | Nurachain 1020 | 0xf0a4eC07916feBa4432121Ed5969887D9b939cD0 |
| Multicall3 | Nurachain 1020 | 0xf58884FCf45d8F5Cc8A73c618D23EB27b732CA24 |
| PredictionFactory | Nurachain 1020 | 0x33fE315c8a7FeA10152dD2b21B5d87936aF9B79d |
| PredictionMarket (implementación; los mercados son clones) | Nurachain 1020 | 0x4b94c8F32Ff506D31d79d21D94eC1d8AE3d1F145 |
| PredictionPool (implementación; los pools son clones) | Nurachain 1020 | 0x675b24758B199c3A5674f0288dfdeaA217fB2A86 |
| PredictionTreasury | Nurachain 1020 | 0xDABEDD148F5AE5f3e130aB811a8975828Ea75AA8 |
| NuraProfileProxy (el registro de perfiles — usar el ABI de `NuraProfile`) | Nurachain 1020 | 0x8CFbcEf737BE3C67A52A20Ae3DCC685ACF759460 |
| NuraProfile (implementación 1.0.0 tras el proxy) | Nurachain 1020 | 0x8ff69542387343fe8a9e053779f23058fBbA7f71 |
| NuraProfileLens | Nurachain 1020 | 0xE8BD8Fc19907274b3CF87Bd72F4cd92Ca3c62F05 |
| SocialVerifier | Nurachain 1020 | 0xc81bF5e81a9aB9447eeE873b916538750f3161D8 |
| resto | Nurachain 1020 | No consta en el repositorio — se registra al desplegar |

## Seguridad transversal

- Sin proxies ni actualizaciones salvo el registro de perfiles: `NuraProfile` es un UUPS tras un proxy ERC-1967, actualizable solo por su propietario en dos pasos, y el administrador no tiene acceso al contenido de los usuarios. El comportamiento de todo lo demás queda fijado al desplegar.
- Las implementaciones de clones llaman `_disableInitializers()`; la inicialización es atómica con la creación.
- Rutas de dinero con checks-effects-interactions y cerrojos de reentrancia en almacenamiento.
- El redondeo siempre favorece a los pozos/tesorería.
- El riesgo permanente es la centralización: resolución, acuñación, pausa y drenaje reducen a claves de administrador.

```text
Documentation completed.  (resumen del sistema en español; referencia completa en inglés)

Missing documentation:    0
```
