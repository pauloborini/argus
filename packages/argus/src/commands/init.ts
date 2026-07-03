import { initWorkspace } from "../workspace/workspace.js";
import { migrateLegacyAthena } from "../memory/migrate-legacy-athena.js";

export function runInit(): number {
  const result = initWorkspace();
  if (!result.ok) {
    console.error(result.message);
    return 1;
  }
  const migration = migrateLegacyAthena();
  if (migration.status === "failed") {
    console.error(migration.message);
    return 1;
  }
  console.log(result.message);
  return 0;
}
