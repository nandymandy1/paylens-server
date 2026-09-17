import BigNumber from "bignumber.js";

BigNumber.config({ DECIMAL_PLACES: 20 });
export { BigNumber };

export function decimal(value: BigNumber.Value): BigNumber {
  return new BigNumber(value);
}
