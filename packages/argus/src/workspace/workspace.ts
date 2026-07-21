import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const WORKSPACE_DIR = ".argus";
export const WORKSPACE_METADATA_FILE = "workspace.json";
export const FILE_MANIFEST_FILE = "file-manifest.json";
export const STRUCTURAL_INDEX_FILE = "structural-index.json";
export const INDEX_DB_FILE = "index.db";
export const DIRTY_FLAG_FILE = "dirty.json";
export const SYNC_LOCK_FILE = "sync.lock";
export const PACKED_HANDLES_DIR = "packed-handles";
export const MEMORY_DIR = "memory";
export const MEMORY_DB_FILE = "memory.db";
export const MEMORY_CONFIG_FILE = "config.json";
export const MEMORY_VAULT_DIR = "vault";
export const PRODUCT_ID = "argus";
export const SCHEMA_VERSION = "1.0.0";

export interface WorkspaceMetadata {
  schema_version: string;
  product_id: typeof PRODUCT_ID;
  initialized_at: string;
  root_path: string;
  /**
   * Respeitar `.gitignore` no discovery (não indexar arquivos ignorados).
   * Ausente em workspaces antigos → tratado como `true` (default de produto).
   */
  respect_gitignore?: boolean;
}

function isWorkspaceMetadata(value: unknown): value is WorkspaceMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }
  const metadata = value as Record<string, unknown>;
  return (
    typeof metadata.schema_version === "string" &&
    metadata.product_id === PRODUCT_ID &&
    typeof metadata.initialized_at === "string" &&
    typeof metadata.root_path === "string" &&
    metadata.root_path.length > 0 &&
    (metadata.respect_gitignore === undefined ||
      typeof metadata.respect_gitignore === "boolean")
  );
}

/**
 * Paths canônicos de estado sob um único `rootPath/.argus/`.
 * Todos os campos absolutos são filhos de `stateDir` (= `join(rootPath, ".argus")`).
 */
export interface WorkspaceStatePaths {
  rootPath: string;
  stateDir: string;
  metadata: string;
  manifest: string;
  structuralIndex: string;
  indexDb: string;
  dirtyFlag: string;
  syncLock: string;
  memoryDir: string;
  memoryDb: string;
  packedHandlesDir: string;
}

/** Default de produto: respeitar `.gitignore`. Override por CLI vence. */
export function resolveRespectGitignore(
  metadata: Pick<WorkspaceMetadata, "respect_gitignore"> | null,
  cliOverride?: boolean,
): boolean {
  if (cliOverride !== undefined) {
    return cliOverride;
  }
  return metadata?.respect_gitignore ?? true;
}

export interface WorkspaceResult {
  ok: boolean;
  created: boolean;
  message: string;
  metadata?: WorkspaceMetadata;
}

/**
 * Diretório `.argus` do workspace.
 * @param rootPath Raiz canônica do workspace (pai de `.argus`), **não** um cwd arbitrário de shell.
 */
export function getWorkspacePath(rootPath: string = process.cwd()): string {
  return join(resolve(rootPath), WORKSPACE_DIR);
}

/**
 * @param rootPath Raiz canônica do workspace (pai de `.argus`), **não** um cwd arbitrário de shell.
 */
export function getMetadataPath(rootPath: string = process.cwd()): string {
  return join(getWorkspacePath(rootPath), WORKSPACE_METADATA_FILE);
}

/**
 * @param rootPath Raiz canônica do workspace (pai de `.argus`), **não** um cwd arbitrário de shell.
 */
export function getManifestPath(rootPath: string = process.cwd()): string {
  return join(getWorkspacePath(rootPath), FILE_MANIFEST_FILE);
}

/**
 * @param rootPath Raiz canônica do workspace (pai de `.argus`), **não** um cwd arbitrário de shell.
 */
export function getStructuralIndexPath(rootPath: string = process.cwd()): string {
  return join(getWorkspacePath(rootPath), STRUCTURAL_INDEX_FILE);
}

/**
 * @param rootPath Raiz canônica do workspace (pai de `.argus`), **não** um cwd arbitrário de shell.
 */
export function getIndexDbPath(rootPath: string = process.cwd()): string {
  return join(getWorkspacePath(rootPath), INDEX_DB_FILE);
}

/**
 * @param rootPath Raiz canônica do workspace (pai de `.argus`), **não** um cwd arbitrário de shell.
 */
export function getDirtyFlagPath(rootPath: string = process.cwd()): string {
  return join(getWorkspacePath(rootPath), DIRTY_FLAG_FILE);
}

/**
 * @param rootPath Raiz canônica do workspace (pai de `.argus`), **não** um cwd arbitrário de shell.
 */
export function getSyncLockPath(rootPath: string = process.cwd()): string {
  return join(getWorkspacePath(rootPath), SYNC_LOCK_FILE);
}

/**
 * @param rootPath Raiz canônica do workspace (pai de `.argus`), **não** um cwd arbitrário de shell.
 */
export function getPackedHandlesDirPath(rootPath: string = process.cwd()): string {
  return join(getWorkspacePath(rootPath), PACKED_HANDLES_DIR);
}

/**
 * @param rootPath Raiz canônica do workspace (pai de `.argus`), **não** um cwd arbitrário de shell.
 */
export function getMemoryPath(rootPath: string = process.cwd()): string {
  return join(getWorkspacePath(rootPath), MEMORY_DIR);
}

/**
 * @param rootPath Raiz canônica do workspace (pai de `.argus`), **não** um cwd arbitrário de shell.
 */
export function getMemoryDbPath(rootPath: string = process.cwd()): string {
  return join(getMemoryPath(rootPath), MEMORY_DB_FILE);
}

/**
 * Paths de estado canônicos sob `rootPath/.argus/`.
 * Contrato: o argumento é o **root do workspace** pós-resolve/heal, não um startCwd de discovery.
 * Todos os paths retornados são filhos de `join(rootPath, ".argus")`.
 */
export function getStatePaths(rootPath: string): WorkspaceStatePaths {
  const root = resolve(rootPath);
  const stateDir = getWorkspacePath(root);
  return {
    rootPath: root,
    stateDir,
    metadata: join(stateDir, WORKSPACE_METADATA_FILE),
    manifest: join(stateDir, FILE_MANIFEST_FILE),
    structuralIndex: join(stateDir, STRUCTURAL_INDEX_FILE),
    indexDb: join(stateDir, INDEX_DB_FILE),
    dirtyFlag: join(stateDir, DIRTY_FLAG_FILE),
    syncLock: join(stateDir, SYNC_LOCK_FILE),
    memoryDir: join(stateDir, MEMORY_DIR),
    memoryDb: join(stateDir, MEMORY_DIR, MEMORY_DB_FILE),
    packedHandlesDir: join(stateDir, PACKED_HANDLES_DIR),
  };
}

export function workspaceExists(rootPath: string = process.cwd()): boolean {
  return existsSync(getMetadataPath(rootPath));
}

export function readWorkspaceMetadata(rootPath: string = process.cwd()): WorkspaceMetadata | null {
  const metaPath = getMetadataPath(rootPath);
  if (!existsSync(metaPath)) {
    return null;
  }
  try {
    const raw = readFileSync(metaPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return isWorkspaceMetadata(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function initWorkspace(rootPath: string = process.cwd()): WorkspaceResult {
  const root = resolve(rootPath);
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
          "E_WORKSPACE_INVALID: Metadados corrompidos em .argus/workspace.json. Remova .argus/ ou repare o arquivo e execute argus init novamente.",
      };
    }
    return {
      ok: true,
      created: false,
      message: "Workspace já preparado. Próximo passo: argus index para gerar o manifest local.",
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
      respect_gitignore: true,
    };

    writeFileSync(metaPath, JSON.stringify(metadata, null, 2) + "\n", "utf-8");

    return {
      ok: true,
      created: true,
      message: "Workspace preparado. Próximo passo: argus index para gerar o manifest local.",
      metadata,
    };
  } catch {
    return {
      ok: false,
      created: false,
      message:
        "E_WORKSPACE_INVALID: Não foi possível criar workspace em .argus/. Verifique permissões do diretório.",
    };
  }
}

export function requireWorkspace(rootPath: string = process.cwd()): WorkspaceMetadata {
  const metadata = readWorkspaceMetadata(rootPath);
  if (!metadata) {
    throw new Error("E_WORKSPACE_INVALID: Workspace não preparado ou path inválido. Execute argus init.");
  }
  return metadata;
}
