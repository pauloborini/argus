import { bar } from "./bar";

export function foo(): void {
  bar();
}

export class Baz extends Qux implements IQ {
  run(): void {
    foo();
  }
}
