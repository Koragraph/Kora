// All rounding in ledgerkit goes through this module.

export function roundHalfAwayFromZero(x) {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

export function roundHalfEven(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}
