import { helper } from "@app/util";
import { helper as relativeHelper } from "./util";

export function run(): string {
  return `${helper()}-${relativeHelper()}`;
}
