# Sistema de Contratos Inteligentes — Visão Geral

> **English:** [`docs/contracts/README.md`](../../contracts/README.md) · **فارسی:** [`docs/fa/contracts/README.md`](../../fa/contracts/README.md)
> A documentação detalhada de cada contrato (funções, eventos, erros, segurança) está em inglês em `docs/contracts/`.

Documentação de todos os contratos do repositório, gerada a partir do código-fonte real em `contracts/`. Cada contrato próprio tem um arquivo completo em inglês; esta página resume o sistema inteiro.

## Índice de contratos

| Contrato | Arquivo | Tipo |
| --- | --- | --- |
| `BridgeToken` | contracts/token/BridgeToken.sol | base ERC20 abstrata |
| `BridgeUSDT` / `BridgeBNB` | token/*.sol | tokens de ponte (18 decimais) |
| `Airdrop` | airdrop/Airdrop.sol | distribuição de moeda nativa assinada com EIP-712 |
| `CollateralizedNFT` | vault/CollateralizedNFT.sol | cofre ERC721 lastreado por um ERC20 |
| `PredictionFactory` | forecast/PredictionFactory.sol | fábrica de clones + registro |
| `PredictionMarket` | forecast/PredictionMarket.sol | mercado de previsão CPMM (ERC-1155) |
| `PredictionPool` | forecast/PredictionPool.sol | mercado parimutuel |
| `PredictionTreasury` | forecast/PredictionTreasury.sol | tesouraria de taxas |
| `NuraProfile` | profile/NuraProfile.sol | registro de perfis (UUPS): nome de usuário único, campos multilíngues, extensões |
| `FeeMath` / `MarketMath` | forecast/libraries | bibliotecas matemáticas |
| `WNURA` | testing/WNURA.sol | nativo embrulhado (WETH9) |
| `MockToken` | testing/MockToken.sol | token de teste |
| Uniswap V3 (vendored) | contracts/univ3 | árvore de terceiros documentada como grupo |

As interfaces (`IPredictionFactory`, `IPredictionMarket`, `IPredictionPool`,
`IPredictionTreasury`, `IBackingToken`) e os tipos compartilhados estão documentados dentro dos contratos na versão inglesa.

## Arquitetura central

```text
   BridgeUSDT/BridgeBNB          PredictionFactory ──createMarket──▶ CollateralizedNFT
        ▲                             │        └─createMarket2▶ clone EIP-1167
        │ mint/adminBurn              │ clones                       │
   users ◀── Transfer ──── PredictionMarket   PredictionPool         │
                                   ▼                  ▼                 ▼
                            trading CPMM/apostas  apostas/claims ─▶ Treasury
```

### Os dois motores de previsão

Ambos são registrados na mesma fábrica e compartilham estados, tesouraria e superfície de eventos:

| | ‏PredictionMarket (‏createMarket) | ‏PredictionPool (‏createMarket2) |
| --- | --- | --- |
| Modelo | AMM de produto constante sobre reservas virtuais | poço parimutuel |
| Instrumentos | participações ERC-1155 + LP | contabilidade direta de apostas |
| Liquidez inicial | exigida (criação payable) | nenhuma (rejeita valor anexado) |
| Resolução antecipada | possível **antes** de lockTime (pressuposto de confiança) | impossível — ‏`LockNotReached` |
| Taxas | divisão protocolo/LP por operação | uma taxa única ao resolver |

## Modelo de permissões

| Contrato | Papéis | Poderes críticos |
| --- | --- | --- |
| Tokens de ponte | DEFAULT_ADMIN/MINTER/BURNER/PAUSER | mint sem lastro, queima confiscatória, pausa global, resgate |
| Airdrop | DEFAULT_ADMIN/PAUSER/SIGNER | drenar, reprecificar, pausar; o assinante define elegibilidade |
| Vault | DEFAULT_ADMIN/MINTER + chave de mint público | tamanho futuro do bloqueio, abrir mint livre, sacar **apenas a parte livre** |
| Fábrica Forecast | ADMIN_ROLE | criar mercados (taxa ≤ 10%), resolver/anular todos, redirecionar tesourarias |
| Mercados | confiam no controller (fábrica) | ciclo de vida só via relé da fábrica |
| Tesouraria | dono Ownable2Step | sacar todas as taxas, mudar destinatário |

Cada módulo Ignition concede o papel admin ao implantador por padrão — mova-os para um multisig antes de valor real.

## Fluxos principais do usuário

```text
Operar CPMM:  buy{value}(i,minOut,deadline) ─▶ fee ─▶ Treasury ; após MarketResolved(w): redeem()
Apostar Pool: bet{value}(i) até lockTime ─▶ resolve do admin ─▶ claim() proporcional
Ponte:        o relayer faz mint na entrada; BURNER queima na saída
Vault:        deposit ─▶ mint NFT (reserva lockAmount) ── redeem paga ao dono
Airdrop:      o backend assina Claim(account,deadline) ─▶ getReward() ─▶ pagamento nativo
```

## Informações de implantação registradas

| Contrato | Rede | Endereço |
| --- | --- | --- |
| BridgeUSDT | Nurachain 1020 | 0x4E0DB0B1Da408faF5637202CF48b0bc7733bE6dC |
| BridgeBNB | Nurachain 1020 | 0xD4221Ad9772BF5bA7423a044bBBEe6af2154A5Fc |
| WNURA | Nurachain 1020 | 0xf0a4eC07916feBa4432121Ed5969887D9b939cD0 |
| Multicall3 | Nurachain 1020 | 0xf58884FCf45d8F5Cc8A73c618D23EB27b732CA24 |
| PredictionFactory | Nurachain 1020 | 0x33fE315c8a7FeA10152dD2b21B5d87936aF9B79d |
| PredictionMarket (implementação; os mercados são clones) | Nurachain 1020 | 0x4b94c8F32Ff506D31d79d21D94eC1d8AE3d1F145 |
| PredictionPool (implementação; os pools são clones) | Nurachain 1020 | 0x675b24758B199c3A5674f0288dfdeaA217fB2A86 |
| PredictionTreasury | Nurachain 1020 | 0xDABEDD148F5AE5f3e130aB811a8975828Ea75AA8 |
| NuraProfileProxy (o registro de perfis — usar a ABI de `NuraProfile`) | Nurachain 1020 | 0x8CFbcEf737BE3C67A52A20Ae3DCC685ACF759460 |
| NuraProfile (implementação 1.0.0 atrás do proxy) | Nurachain 1020 | 0x8ff69542387343fe8a9e053779f23058fBbA7f71 |
| NuraProfileLens | Nurachain 1020 | 0xE8BD8Fc19907274b3CF87Bd72F4cd92Ca3c62F05 |
| SocialVerifier | Nurachain 1020 | 0xc81bF5e81a9aB9447eeE873b916538750f3161D8 |
| demais | Nurachain 1020 | Não consta no repositório — registrado na implantação |

## Segurança transversal

- Sem proxies nem upgrades, exceto o registro de perfis: `NuraProfile` é um UUPS atrás de um proxy ERC-1967, atualizável apenas pelo seu proprietário em duas etapas, e o administrador não tem acesso ao conteúdo dos usuários. O comportamento de todo o resto fica fixado na implantação.
- Implementações de clones chamam `_disableInitializers()`; inicialização é atômica com a criação.
- Caminhos de dinheiro usam checks-effects-interactions com travas de reentrância em storage.
- O arredondamento sempre favorece os poços/tesouraria.
- O risco permanente é centralização: resolução, cunhagem, pausa e drenagem reduzem-se a chaves de administrador.

```text
Documentation completed.  (resumo do sistema em português; referência completa em inglês)

Missing documentation:    0
```
