import { initWorkspace } from "../workspace/workspace.js";

export function runInit(): number {
  const result = initWorkspace();
  console.log(result.message);
  return result.ok ? 0 : 1;
}
