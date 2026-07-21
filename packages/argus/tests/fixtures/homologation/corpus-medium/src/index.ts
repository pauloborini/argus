import { placeOrder } from "./services/order";

export function runDemo(): number {
  return placeOrder("SKU-1", 2);
}
