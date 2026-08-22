import { formatEther, parseEther } from "ethers";

/**
 * The parsing and formatting that deployment inputs pass through, in one place so it can be
 * tested without standing up a network.
 *
 * These functions decide how much money a deployment commits to. `parseReward("200")` is the
 * difference between 200 coin per claim and 200 wei; `parseFromFile` reads a cap that becomes
 * immutable the moment the constructor runs. They used to live as private helpers inside
 * hardhat.config.ts and scripts/vault-setup.ts, where nothing could reach them — the only way
 * to exercise a rounding or regex mistake was to run a real deploy and read the output.
 *
 * Everything here is pure: no environment, no filesystem, no network. Callers own those.
 * See test/scripts/params.test.ts.
 */

/** Strips the separators people type into numbers: 50_000, 50,000 and "50 000" all count. */
function stripSeparators(input: string): string {
  return input.replace(/[_,\s]/g, "");
}

/**
 * A whole number of claims, as a person would type it: 50000, 50_000, 50,000.
 *
 * @throws if it is not a whole number, or is zero — the Airdrop constructor rejects a zero cap,
 *         and the cap is immutable once deployed.
 */
export function parseClaims(answer: string): bigint {
  const digits = stripSeparators(answer);

  if (!/^\d+$/.test(digits)) {
    throw new Error(`"${answer.trim()}" is not a whole number of claims.`);
  }
  if (BigInt(digits) === 0n) {
    throw new Error("The cap has to be at least 1 — the constructor rejects 0.");
  }

  return BigInt(digits);
}

/**
 * A coin amount as a person would type it — 200, 0.5 — converted to wei.
 *
 * @throws if it does not parse, or is not above zero. parseEther accepts a leading minus,
 *         which a uint256 constructor argument cannot hold, so that check is not redundant.
 */
export function parseReward(answer: string): bigint {
  let wei: bigint;

  try {
    wei = parseEther(stripSeparators(answer));
  } catch {
    throw new Error(`"${answer.trim()}" is not an amount.`);
  }

  if (wei <= 0n) {
    throw new Error("The reward has to be above 0 — the constructor rejects 0.");
  }

  return wei;
}

/**
 * Reads one already-scaled value out of an Ignition --parameters file, in Ignition's own
 * bigint spelling: a number, or a digit string optionally suffixed with "n".
 *
 * @returns undefined when the key is absent, so a caller can tell "not supplied" apart from
 *          "supplied and invalid" — the first is a prompt, the second is an error.
 */
export function parseFromFile(value: unknown, name: string): bigint | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^[1-9]\d*n?$/.test(value)) {
    return BigInt(value.replace(/n$/, ""));
  }

  throw new Error(
    `"${name}" in the parameters file is not a positive whole number: ${JSON.stringify(value)}`,
  );
}

/** 10000000.0 is hard to read when it is the bill you are about to pay; 10,000,000 is not. */
export function coinAmount(wei: bigint): string {
  const [whole, fraction] = formatEther(wei).split(".");
  const grouped = BigInt(whole).toLocaleString("en-US");

  return fraction === "0" ? grouped : `${grouped}.${fraction}`;
}

/**
 * Formats a scaled token amount at the token's own decimals, grouped for reading.
 *
 * @dev Deliberately not ethers' formatUnits: this groups the whole part and trims trailing
 *      zeros from the fraction, so 2500000e18 reads as "2,500,000" rather than "2500000.0".
 */
export function formatUnits(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;

  const grouped = whole.toLocaleString("en-US");
  if (fraction === 0n) {
    return grouped;
  }

  return `${grouped}.${fraction.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}

/**
 * A positive whole number of tokens from an environment variable, unscaled.
 *
 * @param raw      The raw variable, or undefined when it is unset.
 * @param name     Variable name, for the error message.
 * @param fallback Used when the variable is unset or empty.
 * @throws if it is set but is not a positive whole number. Silently falling back there would
 *         fund a deployment with the default after someone asked for something else.
 */
export function parseWholeTokens(
  raw: string | undefined,
  name: string,
  fallback: bigint,
): bigint {
  const trimmed = raw?.trim();

  if (trimmed === undefined || trimmed === "") {
    return fallback;
  }

  const digits = stripSeparators(trimmed);
  if (!/^\d+$/.test(digits) || BigInt(digits) === 0n) {
    throw new Error(`${name} must be a positive whole number of tokens, got "${raw}".`);
  }

  return BigInt(digits);
}
