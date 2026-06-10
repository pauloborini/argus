export const WORKSPACE_DIR = ".cortex";
export const PRODUCT_ID = "atlas-cortex";
export const SCHEMA_VERSION = "1.0.0";

export interface WorkspaceMetadata {
  schema_version: string;
  product_id: typeof PRODUCT_ID;
  initialized_at: string;
  root_path: string;
}

export interface WorkspaceResult {
  ok: boolean;
  created: boolean;
  message: string;
  metadata?: WorkspaceMetadata;
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function getWorkspacePath(cwd: string = process.cwd()): string {
  return join(resolve(cwd), WORKSPACE_DIR);
}

export function getMetadataPath(cwd: string = process.cwd()): string {
  return join(getWorkspacePath(cwd), "workspace.json");
}

export function workspaceExists(cwd: string = process.cwd()): boolean {
  return existsSync(getMetadataPath(cwd));
}

export function readWorkspaceMetadata(cwd: string = process.cwd()): WorkspaceMetadata | null {
  const metaPath = getMetadataPath(cwd);
  if (!existsSync(metaPath)) {
    return null;
  }
  try {
    const raw = readFileSync(metaPath, "utf-8");
    return JSON.parse(raw) as WorkspaceMetadata;
  } catch {
    return null;
  }
}

export function initWorkspace(cwd: string = process.cwd()): WorkspaceResult {
  const root = resolve(cwd);
  const wsPath = getWorkspacePath(root);
  const metaPath = getMetadataPath(root);
  const alreadyExists = existsSync(metaPath);

  if (alreadyExists) {
    const existing = readWorkspaceMetadata(root);
    return {
      ok: true,
      created: false,
      message:
        "Workspace já preparado. Próximo passo: cortex index (indisponível até S04 — indexação real pendente).",
      metadata: existing ?? undefined,
    };
  }

  mkdirSync(wsPath, { recursive: true });

  const metadata: WorkspaceMetadata = {
    schema_version: SCHEMA_VERSION,
    product_id: PRODUCT_ID,
    initialized_at: new Date().toISOString(),
    root_path: root,
  };

  writeFileSync(metaPath, JSON.stringify(metadata, null, 2) + "\n", "utf-8");

  return {
    ok: true,
    created: true,
    message:
      "Workspace preparado. Próximo passo: cortex index (indisponível até S04 — indexação real pendente).",
    metadata,
  };
}

export function requireWorkspace(cwd: string = process.cwd()): WorkspaceMetadata {
  const metadata = readWorkspaceMetadata(cwd);
  if (!metadata) {
    throw new Error("E_WORKSPACE_INVALID: Workspace não preparado ou path inválido. Execute cortex init.");
  }
  return metadata;
}
