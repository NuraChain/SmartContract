import { expect } from "chai";

import {
  coinAmount,
  formatUnits,
  parseClaims,
  parseFromFile,
  parseReward,
  parseWholeTokens,
} from "../../scripts/lib/params.ts";

/**
 * Unit tests for the deployment input layer.
 *
 * Nothing here touches a network, a file or an environment variable — these are the pure
 * functions the deploy task and scripts/vault-setup.ts run every input through, and they are
 * the last thing between a typo and a contract that is deployed wrong. A cap parsed loosely
 * is immutable once the Airdrop constructor runs; a reward parsed as wei instead of coin is a
 * pool short by eighteen orders of magnitude.
 */

describe("deployment input parsing", () => {
  describe("parseClaims", () => {
    it("accepts a plain whole number", () => {
      expect(parseClaims("50000")).to.equal(50_000n);
      expect(parseClaims("1")).to.equal(1n);
    });

    it("accepts the separators people actually type", () => {
      for (const input of ["50_000", "50,000", "50 000", " 50000 "]) {
        expect(parseClaims(input)).to.equal(50_000n);
      }
    });

    it("accepts a cap far beyond what a JS number can hold", () => {
      // The cap is a uint256 on-chain; going through Number would silently round here.
      const huge = "123456789012345678901234567890";
      expect(parseClaims(huge)).to.equal(123456789012345678901234567890n);
    });

    it("rejects zero, because the constructor does", () => {
      expect(() => parseClaims("0")).to.throw("at least 1");
      expect(() => parseClaims("0_0")).to.throw("at least 1");
    });

    it("rejects anything that is not a whole number", () => {
      for (const input of ["", "abc", "1.5", "1e3", "-1", "0x10", "1,5.0", "٣"]) {
        expect(() => parseClaims(input), input).to.throw();
      }
    });

    it("quotes the original input in the error, not the stripped one", () => {
      expect(() => parseClaims(" 1.5 ")).to.throw('"1.5" is not a whole number of claims.');
    });
  });

  describe("parseReward", () => {
    it("reads whole coin and scales to wei", () => {
      expect(parseReward("200")).to.equal(200n * 10n ** 18n);
      expect(parseReward("1")).to.equal(10n ** 18n);
    });

    it("reads fractional coin", () => {
      expect(parseReward("0.5")).to.equal(5n * 10n ** 17n);
      expect(parseReward("0.000000000000000001")).to.equal(1n);
    });

    it("accepts separators", () => {
      expect(parseReward("1_000")).to.equal(1000n * 10n ** 18n);
      expect(parseReward("1,000.5")).to.equal(10005n * 10n ** 17n);
    });

    it("rejects zero and negatives, which a uint256 argument cannot hold", () => {
      // parseEther itself is happy with a leading minus, so this check is doing real work.
      expect(() => parseReward("0")).to.throw("above 0");
      expect(() => parseReward("0.0")).to.throw("above 0");
      expect(() => parseReward("-1")).to.throw("above 0");
    });

    it("rejects amounts finer than a wei rather than rounding them away", () => {
      expect(() => parseReward("0.0000000000000000001")).to.throw("is not an amount");
    });

    it("rejects text and empty input", () => {
      for (const input of ["", "abc", "1.2.3", "0x1"]) {
        expect(() => parseReward(input), input).to.throw();
      }
    });
  });

  describe("parseFromFile", () => {
    it("returns undefined for an absent key, so the caller can prompt instead", () => {
      expect(parseFromFile(undefined, "airdrop.maxClaims")).to.equal(undefined);
    });

    it("reads a plain JSON number", () => {
      expect(parseFromFile(50000, "airdrop.maxClaims")).to.equal(50_000n);
    });

    it("reads Ignition's bigint spelling, with and without the suffix", () => {
      expect(parseFromFile("50000n", "airdrop.maxClaims")).to.equal(50_000n);
      expect(parseFromFile("50000", "airdrop.maxClaims")).to.equal(50_000n);
    });

    it("reads a value past Number.MAX_SAFE_INTEGER from its string form", () => {
      // 200 coin in wei. As a JSON number this would lose precision; as a string it does not.
      expect(parseFromFile("200000000000000000000n", "airdrop.rewardAmount")).to.equal(
        200n * 10n ** 18n,
      );
    });

    it("rejects a number too large to be exact", () => {
      // Number.isSafeInteger is what stops a silently rounded literal getting through.
      expect(() => parseFromFile(2 ** 53, "airdrop.maxClaims")).to.throw("not a positive whole number");
    });

    it("rejects zero, negatives and fractions", () => {
      for (const value of [0, -1, 1.5, "0", "0n", "-1", "1.5"]) {
        expect(() => parseFromFile(value, "airdrop.maxClaims"), JSON.stringify(value)).to.throw();
      }
    });

    it("rejects leading zeros, which would read as a different number elsewhere", () => {
      expect(() => parseFromFile("0050", "airdrop.maxClaims")).to.throw();
    });

    it("rejects wrong types outright", () => {
      for (const value of [null, true, [], {}, "abc", "1e3"]) {
        expect(() => parseFromFile(value, "airdrop.maxClaims"), JSON.stringify(value)).to.throw();
      }
    });

    it("names the offending key and shows the value in the error", () => {
      expect(() => parseFromFile("nope", "airdrop.rewardAmount")).to.throw(
        '"airdrop.rewardAmount" in the parameters file is not a positive whole number: "nope"',
      );
    });
  });

  describe("coinAmount", () => {
    it("groups the whole part", () => {
      expect(coinAmount(10_000_000n * 10n ** 18n)).to.equal("10,000,000");
      expect(coinAmount(200n * 10n ** 18n)).to.equal("200");
    });

    it("keeps a fraction when there is one", () => {
      expect(coinAmount(5n * 10n ** 17n)).to.equal("0.5");
      expect(coinAmount(1_500n * 10n ** 15n)).to.equal("1.5");
    });

    it("handles zero and one wei", () => {
      expect(coinAmount(0n)).to.equal("0");
      expect(coinAmount(1n)).to.equal("0.000000000000000001");
    });
  });

  describe("formatUnits", () => {
    it("groups a whole amount at 18 decimals", () => {
      expect(formatUnits(2_500_000n * 10n ** 18n, 18)).to.equal("2,500,000");
      expect(formatUnits(250n * 10n ** 18n, 18)).to.equal("250");
    });

    it("works at other decimal counts", () => {
      // The reason the setup script reads decimals() instead of assuming 18.
      expect(formatUnits(2_500_000n * 10n ** 6n, 6)).to.equal("2,500,000");
      expect(formatUnits(1234n, 2)).to.equal("12.34");
      expect(formatUnits(1234n, 0)).to.equal("1,234");
    });

    it("trims trailing zeros from the fraction but keeps leading ones", () => {
      expect(formatUnits(1_500_000_000_000_000_000n, 18)).to.equal("1.5");
      expect(formatUnits(1_000_000_000_000_000_001n, 18)).to.equal("1.000000000000000001");
      expect(formatUnits(10n ** 15n, 18)).to.equal("0.001");
    });

    it("handles zero and sub-unit amounts", () => {
      expect(formatUnits(0n, 18)).to.equal("0");
      expect(formatUnits(1n, 18)).to.equal("0.000000000000000001");
    });

    it("does not lose precision on very large balances", () => {
      const huge = (2n ** 200n) * 10n ** 18n;
      expect(formatUnits(huge, 18)).to.equal(BigInt(2n ** 200n).toLocaleString("en-US"));
    });
  });

  describe("parseWholeTokens", () => {
    const FALLBACK = 2_500_000n;

    it("falls back when the variable is unset or blank", () => {
      expect(parseWholeTokens(undefined, "VAULT_RESERVE", FALLBACK)).to.equal(FALLBACK);
      expect(parseWholeTokens("", "VAULT_RESERVE", FALLBACK)).to.equal(FALLBACK);
      expect(parseWholeTokens("   ", "VAULT_RESERVE", FALLBACK)).to.equal(FALLBACK);
    });

    it("reads a whole number with or without separators", () => {
      expect(parseWholeTokens("1000", "VAULT_RESERVE", FALLBACK)).to.equal(1000n);
      expect(parseWholeTokens("2_500_000", "VAULT_RESERVE", FALLBACK)).to.equal(2_500_000n);
      expect(parseWholeTokens("2,500,000", "VAULT_RESERVE", FALLBACK)).to.equal(2_500_000n);
    });

    it("throws rather than falling back when the value is set but invalid", () => {
      // Silently defaulting here would fund a deployment with 2,500,000 after someone
      // explicitly asked for something else.
      for (const input of ["0", "-5", "1.5", "abc", "1e6"]) {
        expect(() => parseWholeTokens(input, "VAULT_RESERVE", FALLBACK), input).to.throw(
          "VAULT_RESERVE must be a positive whole number",
        );
      }
    });

    it("names the variable and echoes the raw value in the error", () => {
      expect(() => parseWholeTokens("1.5", "VAULT_RESERVE", FALLBACK)).to.throw(
        'VAULT_RESERVE must be a positive whole number of tokens, got "1.5".',
      );
    });
  });
});
