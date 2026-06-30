import { initWorkspace } from "../workspace/workspace.js";

export function runInit(): number {
  const result = initWorkspace();
  if (result.ok) {
    console.log(result.message);
  } else {
    console.error(result.message);
  }
  return result.ok ? 0 : 1;
}
