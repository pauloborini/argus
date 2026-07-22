export { RESPONSE_STATES, stubResponse, deriveConfidence, isResponseState } from "./contracts/response-state.js";
export type { ResponseState, OperationalEnvelope, Confidence } from "./contracts/response-state.js";
export { MCP_TOOL_NAMES, MCP_SERVER_NAME } from "./mcp/tool-registry.js";
export type { DiscoveredFile, DiscoveryManifest, FileFingerprint } from "./discovery/types.js";
export {
  DEFAULT_IGNORED_DIRECTORIES,
  DEFAULT_IGNORED_SUFFIXES,
  DEFAULT_MAX_FILE_COUNT,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  shouldIgnore,
} from "./discovery/ignores.js";
export { discoverFiles } from "./discovery/walk.js";
export {
  buildDiscoveryManifest,
  fingerprintDiscoveredFiles,
  fingerprintFile,
  hashFile,
} from "./discovery/fingerprint.js";
export { diffManifest } from "./discovery/delta.js";
export { computeManifestStaleness } from "./discovery/staleness.js";
export { readManifest, writeManifestAtomic } from "./discovery/manifest.js";
export {
  FILE_MANIFEST_FILE,
  PRODUCT_ID,
  WORKSPACE_DIR,
  WORKSPACE_METADATA_FILE,
  getManifestPath,
  getMetadataPath,
  getStatePaths,
  getWorkspacePath,
  initWorkspace,
  readWorkspaceMetadata,
  requireWorkspace,
  workspaceExists,
} from "./workspace/workspace.js";
export type { WorkspaceStatePaths } from "./workspace/workspace.js";
export {
  ARGUS_WORKSPACE_ROOT_ENV,
  W_WORKSPACE_ROOT_HEALED,
  findShadowArgusState,
  healRootPathIfNeeded,
  requireWorkspaceRoot,
  resolveLocalStateRoot,
  resolveWorkspaceRoot,
} from "./workspace/resolve-workspace.js";
export type { ShadowArgusState, WorkspaceHandle, WorkspaceResolutionOptions } from "./workspace/resolve-workspace.js";
export { resolveServeWorkspaceRoot } from "./workspace/resolve-serve-root.js";
