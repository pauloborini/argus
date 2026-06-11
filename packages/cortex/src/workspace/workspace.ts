import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const WORKSPACE_DIR = ".cortex";
export const WORKSPACE_METADATA_FILE = "workspace.json";
export const FILE_MANIFEST_FILE = "file-manifest.json";
export const STRUCTURAL_INDEX_FILE = "structural-index.json";
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

export function getWorkspacePath(cwd: string = process.cwd()): string {
  return join(resolve(cwd), WORKSPACE_DIR);
}

export function getMetadataPath(cwd: string = process.cwd()): string {
  return join(getWorkspacePath(cwd), WORKSPACE_METADATA_FILE);
}

export function getManifestPath(cwd: string = process.cwd()): string {
  return join(getWorkspacePath(cwd), FILE_MANIFEST_FILE);
}

export function getStructuralIndexPath(cwd: string = process.cwd()): string {
  return join(getWorkspacePath(cwd), STRUCTURAL_INDEX_FILE);
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
    if (!existing) {
      return {
        ok: false,
        created: false,
        message:
          "E_WORKSPACE_INVALID: Metadados corrompidos em .cortex/workspace.json. Remova .cortex/ ou repare o arquivo e execute cortex init novamente.",
      };
    }
    return {
      ok: true,
      created: false,
      message: "Workspace já preparado. Próximo passo: cortex index para gerar o manifest local.",
      metadata: existing,
    };
  }

  try {
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
      message: "Workspace preparado. Próximo passo: cortex index para gerar o manifest local.",
      metadata,
    };
  } catch {
    return {
      ok: false,
      created: false,
      message:
        "E_WORKSPACE_INVALID: Não foi possível criar workspace em .cortex/. Verifique permissões do diretório.",
    };
  }
}

export function requireWorkspace(cwd: string = process.cwd()): WorkspaceMetadata {
  const metadata = readWorkspaceMetadata(cwd);
  if (!metadata) {
    throw new Error("E_WORKSPACE_INVALID: Workspace não preparado ou path inválido. Execute cortex init.");
  }
  return metadata;
}
