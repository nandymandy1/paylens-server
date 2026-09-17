import BigNumber from 'bignumber.js';
BigNumber.config({
  DECIMAL_PLACES: 20,
  ROUNDING_MODE: BigNumber.ROUND_HALF_UP,
});
export { BigNumber };
export function decimal(value: BigNumber.Value): BigNumber {
  return new BigNumber(value);
}
