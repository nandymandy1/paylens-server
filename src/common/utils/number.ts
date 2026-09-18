import BigNumber from "bignumber.js";

BigNumber.config({ DECIMAL_PLACES: 20 });
export { BigNumber };

export function decimal(value: BigNumber.Value): BigNumber {
  return new BigNumber(value);
}

/**
 * Canonical money serialization: precise decimal string with 2 fraction digits.
 * Never converts through JS float.
 */
export function toMoneyString(value: BigNumber.Value | unknown): string {
  const text = typeof value === "string" ? value : String(value ?? "0");

  return new BigNumber(text).toFixed(2);
}
