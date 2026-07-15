import { resolve } from "node:path";
import type { LanguageCoverage } from "../extraction/types.js";
import type { MemoryStatus } from "../memory/vault-engine.js";
import type { DaemonStatusSnapshot } from "../daemon/runtime.js";
import type { ToolResponsePayload } from "../mcp/tools/common.js";
import { readWorkspaceMetadata } from "../workspace/workspace.js";

function describeIndexState(state: string): string {
  switch (state) {
    case "sucesso":
      return "pronto para uso — índice estrutural completo e em dia";
    case "parcial":
      return "utilizável com ressalvas — há lacunas de cobertura ou limitações conhecidas";
    case "stale":
      return "desatualizado — o filesystem mudou desde o último sync";
    case "falha":
      return "indisponível — workspace inválido ou índice corrompido";
    default:
      return state;
  }
}

function describeIndexStaleness(staleness: string, pending: number): string {
  switch (staleness) {
    case "fresh":
      return "em dia com o filesystem";
    case "stale":
      return pending > 0
        ? `atrás do filesystem — ${pending} arquivo(s) aguardando sync`
        : "atrás do filesystem — rode argus sync";
    case "unknown":
      return "não foi possível verificar com segurança";
    default:
      return staleness;
  }
}

function describeCoverageLevel(level: string, parsed: number, eligible: number): string {
  switch (level) {
    case "full":
      return parsed < eligible
        ? "extração completa, mas nem todos os arquivos elegíveis foram parseados"
        : "extração completa";
    case "partial":
      return "extração parcial — alguns arquivos não foram parseados";
    case "unsupported":
      return "linguagem sem suporte estrutural no Argus";
    default:
      return level;
  }
}

function describeMemoryStaleness(staleness: string): string {
  switch (staleness) {
    case "fresh":
      return "cofre em dia";
    case "stale":
      return "cofre desatualizado — rode argus memory sync";
    case "unknown":
      return "estado do cofre indeterminado";
    default:
      return staleness;
  }
}

function describeEmbeddings(ready: boolean): string {
  return ready
    ? "vetores prontos para busca semântica"
    : "ainda não gerados — busca semântica pode estar limitada";
}

function describeSyncResult(ok: boolean | null): string {
  if (ok === null) {
    return "resultado desconhecido";
  }
  return ok ? "concluído com sucesso" : "falhou — veja o erro abaixo";
}

function describeWatchBackend(backend: string): string {
  switch (backend) {
    case "parcel-watcher":
      return "monitor nativo de arquivos (parcel-watcher)";
    case "poll":
      return "verificação periódica a cada 30s (limite de watches do SO)";
    case "off":
      return "desligado";
    default:
      return backend;
  }
}

function formatRelativePt(iso: string | null | undefined): string | null {
  if (!iso) {
    return null;
  }
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    return iso;
  }
  const deltaMs = Date.now() - at;
  const abs = Math.abs(deltaMs);
  const future = deltaMs < 0;
  const suffix = future ? " (no futuro)" : "";

  if (abs < 60_000) {
    return `agora${suffix}`;
  }
  if (abs < 3_600_000) {
    const min = Math.round(abs / 60_000);
    return `há ${min} min${suffix}`;
  }
  if (abs < 86_400_000) {
    const h = Math.round(abs / 3_600_000);
    return `há ${h} h${suffix}`;
  }
  const d = Math.round(abs / 86_400_000);
  return `há ${d} dia${d === 1 ? "" : "s"}${suffix}`;
}

function padEnd(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function formatCoverageLine(language: string, coverage: LanguageCoverage): string {
  const files =
    coverage.files_parsed === coverage.files_eligible
      ? `${coverage.files_parsed} arquivos indexados`
      : `${coverage.files_parsed} de ${coverage.files_eligible} arquivos indexados`;
  return `  ${padEnd(language, 12)} ${padEnd(files, 28)} ${String(coverage.symbols).padStart(7)} símbolos`;
}

function formatCoverageDetail(language: string, coverage: LanguageCoverage): string {
  return `    ${language}: ${describeCoverageLevel(coverage.coverage_level, coverage.files_parsed, coverage.files_eligible)}`;
}

function formatMemorySection(memory: MemoryStatus | undefined): string[] {
  const lines = ["Memória (cofre local de decisões e insights):"];

  if (!memory?.initialized) {
    lines.push("  Estado: não inicializada — use argus memory init para começar");
    return lines;
  }

  lines.push(`  Notas salvas: ${memory.notes_count}`);
  lines.push(`  Busca semântica: ${describeEmbeddings(memory.embeddings_ready)}`);
  lines.push(`  Sincronização: ${describeMemoryStaleness(memory.staleness)}`);
  if (memory.last_sync_at) {
    lines.push(`  Última sincronização: ${formatRelativePt(memory.last_sync_at)}`);
  } else {
    lines.push("  Última sincronização: nenhuma ainda");
  }
  if (memory.error) {
    lines.push(`  Problema: ${memory.error}`);
  }
  return lines;
}

function formatActionHints(payload: ToolResponsePayload): string[] {
  const lines: string[] = [];
  const hint = typeof payload.staleness_hint === "string" ? payload.staleness_hint : undefined;
  if (hint) {
    lines.push(`→ ${hint.replace(/^[A-Z0-9_]+:\s*/, "")}`);
  }
  const limitations = Array.isArray(payload.limitations)
    ? (payload.limitations as string[]).filter(Boolean)
    : [];
  for (const item of limitations.slice(0, 3)) {
    lines.push(`• ${item}`);
  }
  if (limitations.length > 3) {
    lines.push(`• (+${limitations.length - 3} limitações; use --json --detailed)`);
  }
  return lines;
}

/** Saída legível de `argus status` focada no repositório inspecionado. */
export function formatRepoStatusHuman(payload: ToolResponsePayload, cwd: string): string {
  const metadata = readWorkspaceMetadata(cwd);
  const root = metadata?.root_path ?? resolve(cwd);
  const lines: string[] = [`Repositório: ${root}`, ""];

  if (!payload.initialized) {
    lines.push("Índice estrutural: não inicializado neste repositório");
    lines.push("→ Execute argus init && argus index para começar a indexar o código.");
    lines.push("");
    lines.push(...formatMemorySection(payload.memory as MemoryStatus | undefined));
    return lines.join("\n");
  }

  const state = String(payload.state ?? "desconhecido");
  const staleness = String(payload.staleness ?? "unknown");
  const pending = Number(payload.pending_files_count ?? 0);

  lines.push("Índice estrutural:");
  lines.push(`  Situação geral: ${describeIndexState(state)}`);
  lines.push(`  Sincronização com o código: ${describeIndexStaleness(staleness, pending)}`);

  const dirty = payload.dirty_pending as
    | { paths: number; force_full?: boolean; since_ref?: string | null }
    | null
    | undefined;
  if (dirty && dirty.paths > 0) {
    const since = dirty.since_ref ? ` (desde o commit ${dirty.since_ref})` : "";
    const full = dirty.force_full ? ", reindexação completa pendente" : "";
    lines.push(`  Fila de atualização: ${dirty.paths} caminho(s) marcado(s) por hooks git${since}${full}`);
  }

  if (payload.storage_backend) {
    const schema = payload.schema_version ? ` (versão ${payload.schema_version})` : "";
    lines.push(`  Armazenamento: ${payload.storage_backend}${schema}`);
  }

  const coverage = payload.coverage_by_language as Record<string, LanguageCoverage> | undefined;
  const languages = coverage
    ? Object.entries(coverage)
        .filter(([, item]) => item.files_eligible > 0)
        .sort((a, b) => b[1].symbols - a[1].symbols)
    : [];

  if (languages.length > 0) {
    lines.push("");
    lines.push("Cobertura por linguagem:");
    for (const [language, item] of languages) {
      lines.push(formatCoverageLine(language, item));
      if (item.coverage_level !== "full" || item.files_parsed < item.files_eligible) {
        lines.push(formatCoverageDetail(language, item));
      }
    }
  }

  lines.push("");
  lines.push(...formatMemorySection(payload.memory as MemoryStatus | undefined));

  const hints = formatActionHints(payload);
  if (hints.length > 0 && state !== "sucesso") {
    lines.push("");
    lines.push("Próximo passo:");
    lines.push(...hints);
  }

  return lines.join("\n");
}

function formatDaemonWorkspace(ws: DaemonStatusSnapshot["workspaces"][number]): string[] {
  const lines: string[] = [`Repositório observado: ${ws.root}`];
  const watch = ws.watching
    ? `ativo — ${describeWatchBackend(ws.watch_backend)}`
    : "pausado";
  lines.push(`  Monitoramento de arquivos: ${watch}`);

  if (ws.last_sync_at) {
    const when = formatRelativePt(ws.last_sync_at) ?? ws.last_sync_at;
    const result = describeSyncResult(ws.last_sync_ok);
    const duration = ws.last_sync_duration_ms === null ? "" : ` em ${ws.last_sync_duration_ms}ms`;
    lines.push(
      `  Última atualização do índice: ${when} — ${ws.last_sync_paths} caminho(s), ${result}${duration}`,
    );
  } else {
    lines.push("  Última atualização do índice: nenhuma ainda");
  }

  if (ws.last_event_at) {
    lines.push(`  Última mudança detectada no disco: ${formatRelativePt(ws.last_event_at)}`);
  }

  if (ws.last_error) {
    lines.push(`  Problema na última sync: ${ws.last_error}`);
  }

  return lines;
}

function resolveDaemonWorkspaces(
  status: DaemonStatusSnapshot,
  cwd: string,
  all: boolean,
): { shown: DaemonStatusSnapshot["workspaces"]; hidden: number } {
  if (all || status.workspaces.length <= 1) {
    return { shown: status.workspaces, hidden: 0 };
  }

  const metadata = readWorkspaceMetadata(cwd);
  const root = metadata?.root_path ?? resolve(cwd);
  const match = status.workspaces.find((ws) => resolve(ws.root) === resolve(root));
  if (match) {
    return { shown: [match], hidden: status.workspaces.length - 1 };
  }

  return { shown: status.workspaces, hidden: 0 };
}

/** Saída legível de `argus daemon status` com foco no repositório atual. */
export function formatDaemonStatusHuman(
  pid: number | null,
  status: DaemonStatusSnapshot | null,
  opts?: { cwd?: string; all?: boolean },
): string {
  const cwd = opts?.cwd ?? process.cwd();
  const lines: string[] = [];

  if (pid === null) {
    lines.push("Daemon de auto-sync: parado");
    lines.push("→ O índice não é atualizado automaticamente. Rode argus daemon start.");
    return lines.join("\n");
  }

  lines.push(`Daemon de auto-sync: rodando em segundo plano (pid ${pid})`);

  if (!status) {
    lines.push("Aguardando primeira publicação de status pelo daemon.");
    return lines.join("\n");
  }

  lines.push(`Ativo desde: ${formatRelativePt(status.started_at) ?? status.started_at}`);

  const { shown, hidden } = resolveDaemonWorkspaces(status, cwd, opts?.all === true);
  if (shown.length === 0) {
    lines.push("");
    lines.push("Nenhum repositório está sendo observado no momento.");
    return lines.join("\n");
  }

  for (let i = 0; i < shown.length; i += 1) {
    if (i > 0 || lines.at(-1) !== "") {
      lines.push("");
    }
    lines.push(...formatDaemonWorkspace(shown[i]!));
  }

  if (hidden > 0) {
    lines.push("");
    lines.push(`(+${hidden} outro${hidden === 1 ? "" : "s"} repositório${hidden === 1 ? "" : "s"} em observação; use argus daemon status --all)`);
  }

  return lines.join("\n");
}
