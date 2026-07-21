import { calculateInvoice } from "../billing/calculate";
import { productTotal } from "../catalog/product";

export function placeOrder(sku: string, qty: number): number {
  const subtotal = productTotal(sku, qty);
  return calculateInvoice(subtotal);
}
