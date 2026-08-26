# स्मार्ट कॉन्ट्रैक्ट सिस्टम — अवलोकन

> **English:** [`docs/contracts/README.md`](../../contracts/README.md) · **فارسی:** [`docs/fa/contracts/README.md`](../../fa/contracts/README.md)
> हर कॉन्ट्रैक्ट का विस्तृत दस्तावेज़ीकरण (फ़ंक्शन, इवेंट, एरर, सुरक्षा) अंग्रेज़ी में `docs/contracts/` में उपलब्ध है।

इस रिपॉज़िटरी के सभी कॉन्ट्रैक्ट्स का दस्तावेज़ीकरण, `contracts/` के वास्तविक सोर्स से तैयार। प्रत्येक first-party कॉन्ट्रैक्ट का पूरा फ़ाइल अंग्रेज़ी में है; यह पृष्ठ पूरे सिस्टम का सारांश है।

## कॉन्ट्रैक्ट सूची

| कॉन्ट्रैक्ट | फ़ाइल | प्रकार |
| --- | --- | --- |
| `BridgeToken` | contracts/token/BridgeToken.sol | एब्स्ट्रैक्ट ERC20 आधार |
| `BridgeUSDT` / `BridgeBNB` | token/*.sol | ब्रिज टोकन (18 दशमलव) |
| `Airdrop` | airdrop/Airdrop.sol | EIP-712 हस्ताक्षरित नेटिव-कॉइन वितरण |
| `CollateralizedNFT` | vault/CollateralizedNFT.sol | ERC20-समर्थित ERC721 वॉल्ट |
| `PredictionFactory` | forecast/PredictionFactory.sol | क्लोन फ़ैक्ट्री + रजिस्ट्री |
| `PredictionMarket` | forecast/PredictionMarket.sol | CPMM पूर्वानुमान बाज़ार (ERC-1155) |
| `PredictionPool` | forecast/PredictionPool.sol | पैरिम्युचुअल बाज़ार |
| `PredictionTreasury` | forecast/PredictionTreasury.sol | शुल्क कोष |
| `FeeMath` / `MarketMath` | forecast/libraries | गणित लाइब्रेरीज़ |
| `WNURA` | testing/WNURA.sol | रैप्ड नेटिव कॉइन (WETH9) |
| `MockToken` | testing/MockToken.sol | टेस्ट टोकन |
| Uniswap V3 (vendored) | contracts/univ3 | थर्ड-पार्टी ट्री, समूह-स्तर पर दस्तावेज़ित |

इंटरफेस (`IPredictionFactory`, `IPredictionMarket`, `IPredictionPool`,
`IPredictionTreasury`, `IBackingToken`) और साझा प्रकार अंग्रेज़ी संस्करण में उनके कॉन्ट्रैक्ट्स के भीतर दस्तावेज़ित हैं।

## मुख्य आर्किटेक्चर

```text
   BridgeUSDT/BridgeBNB          PredictionFactory ──createMarket──▶ CollateralizedNFT
        ▲                             │        └─createMarket2▶ EIP-1167 clone
        │ mint/adminBurn              │ clones                       │
   users ◀── Transfer ──── PredictionMarket   PredictionPool         │
                                   ▼                  ▼                 ▼
                            CPMM trading/bets     betting/claims ─▶ Treasury
```

### दो पूर्वानुमान इंजन

दोनों एक ही फ़ैक्ट्री में रजिस्टर होते हैं और lifecycle, ट्रेज़री व इवेंट सतह साझा करते हैं:

| | ‏PredictionMarket (‏createMarket) | ‏PredictionPool (‏createMarket2) |
| --- | --- | --- |
| मॉडल | आभासी रिज़र्व पर CPMM AMM | पैरिम्युचुअल पूल |
| उपकरण | ERC-1155 शेयर + LP शेयर | सीधी बेट लेखा |
| आरंभिक लिक्विडिटी | आवश्यक (payable निर्माण) | कोई नहीं (संलग्न मूल्य अस्वीकृत) |
| शीघ्र रिज़ॉल्यूशन | lockTime **से पहले** संभव (विश्वास का पूर्वाग्रह) | असंभव — ‏`LockNotReached` |
| शुल्क | प्रति ट्रेड protocol/LP विभाजन | resolve पर एकल हाउस शुल्क |

## अनुमति मॉडल

| कॉन्ट्रैक्ट | भूमिकाएँ | महत्वपूर्ण अधिकार |
| --- | --- | --- |
| ब्रिज टोकन | DEFAULT_ADMIN/MINTER/BURNER/PAUSER | बिना समर्थन मिंट, ज़ब्ती बर्न, वैश्विक पॉज़, रेस्क्यू |
| Airdrop | DEFAULT_ADMIN/PAUSER/SIGNER | निकासी, पुनःमूल्यांकन, रोकथाम; signer पात्रता तय करता है |
| Vault | DEFAULT_ADMIN/MINTER + public-mint स्विच | भविष्य का lock आकार, मुफ़्त-mint दौड़, **केवल अनारक्षित** निकासी |
| Forecast फ़ैक्ट्री | ADMIN_ROLE | बाज़ार बनाना (शुल्क ≤ 10%), सबका resolve/void, ट्रेज़री पुनर्निर्देशन |
| बाज़ार | controller (फ़ैक्ट्री) पर भरोसा | lifecycle केवल फ़ैक्ट्री रिले से |
| Treasury | Ownable2Step मालिक | सारे शुल्क निकालना, प्राप्तकर्ता बदलना |

प्रत्येक Ignition मॉड्यूल डिफ़ॉल्ट रूप से deployer को एडमिन भूमिका देता है — असली मूल्य से पहले multisig में ले जाएँ।

## मुख्य उपयोगकर्ता प्रवाह

```text
CPMM ट्रेड:    buy{value}(i,minOut,deadline) ─▶ fee ─▶ Treasury ; MarketResolved(w) के बाद: redeem()
Pool बेट:      bet{value}(i) lockTime तक ─▶ एडमिन resolve ─▶ claim() आनुपातिक
Bridge:        रिलेयर आने पर mint करता है; BURNER जाते समय burn करता है
Vault:         deposit ─▶ mint NFT (lockAmount आरक्षण) ── redeem मालिक को भुगतान
Airdrop:       बैकएंड Claim(account,deadline) साइन करता है ─▶ getReward() ─▶ नेटिव भुगतान
```

## दर्ज डिप्लॉयमेंट जानकारी

| कॉन्ट्रैक्ट | नेटवर्क | पता |
| --- | --- | --- |
| BridgeUSDT | Nurachain 1020 | 0x4E0DB0B1Da408faF5637202CF48b0bc7733bE6dC |
| BridgeBNB | Nurachain 1020 | 0xD4221Ad9772BF5bA7423a044bBBEe6af2154A5Fc |
| WNURA | Nurachain 1020 | 0xf0a4eC07916feBa4432121Ed5969887D9b939cD0 |
| Multicall3 | Nurachain 1020 | 0xf58884FCf45d8F5Cc8A73c618D23EB27b732CA24 |
| शेष | Nurachain 1020 | रिपॉज़िटरी में नहीं मिला — डिप्लॉय के समय दर्ज |

## समग्र सुरक्षा

- कहीं भी प्रॉक्सी/अपग्रेड नहीं; व्यवहार डिप्लॉयमेंट पर तय होता है।
- क्लोन implementations `_disableInitializers()` कॉल करते हैं; initialization निर्माण के साथ atomic है।
- पैसों के रास्ते checks-effects-interactions + storage आधारित reentrancy locks का पालन करते हैं।
- राउंडिंग हमेशा पूल/ट्रेज़री के पक्ष में।
- स्थायी जोखिम केंद्रीकरण है: resolution, minting, pause और drainage सब एडमिन कुंजियों तक आते हैं।

```text
Documentation completed.  (सिस्टम सारांश हिन्दी में; पूर्ण संदर्भ अंग्रेज़ी में)

Missing documentation:    0
```
