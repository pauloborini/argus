import { lookupPrice } from "./price";

export function productTotal(sku: string, qty: number): number {
  return lookupPrice(sku) * qty;
}
