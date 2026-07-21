import { computeTax } from "./tax";

export function calculateInvoice(subtotal: number): number {
  return subtotal + computeTax(subtotal);
}
