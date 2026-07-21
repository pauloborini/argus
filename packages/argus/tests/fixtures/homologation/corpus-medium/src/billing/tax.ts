export function computeTax(amount: number, rate = 0.1): number {
  return Math.round(amount * rate * 100) / 100;
}
