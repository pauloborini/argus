import { stubResponse } from "../contracts/response-state.js";
import type { ToolResponsePayload } from "../mcp/tools/common.js";
import { DEFAULT_MAX_CONTEXT_TOKENS, loadMemoryConfig } from "./config.js";
import { analyzeGaps } from "./gap-analyzer.js";
import { createLlmProvider, LlmProviderError } from "./llm-provider.js";
import { VaultEngine, type MemorySearchResult } from "./vault-engine.js";

export class ThinkEngine {
  static async think(
    goal: string,
    options: { context?: string; dryRun?: boolean; cwd?: string } = {},
  ): Promise<ToolResponsePayload> {
    const cwd = options.cwd ?? process.cwd();
    const config = loadMemoryConfig(cwd);
    const maxContextTokens = config?.max_context_tokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
    let chunks: MemorySearchResult[] = [];
    if (!options.context) {
      const recalled = await VaultEngine.recall(goal, { limit: 10, includeContent: true }, cwd);
      chunks = recalled.chunks;
    }
    const notes = chunks.map((chunk) => ({ title: chunk.title, tags: [] }));
    const gaps = analyzeGaps(goal, notes);
    const context = options.context ?? chunks.map((chunk) => `[Nota: ${chunk.path}]\n${chunk.content ?? chunk.snippet}`).join("\n\n");
    const boundedContext = context.length / 4 > maxContextTokens ? context.slice(0, maxContextTokens * 4) : context;
    const prompt = [
      "Responda com base exclusivamente no contexto.",
      "Use citacoes inline no formato [Nota: caminho].",
      "",
      `Pergunta: ${goal}`,
      "",
      `Contexto:\n${boundedContext}`,
    ].join("\n");
    const citations = chunks.map((chunk) => ({ title: chunk.title, relative_path: chunk.path }));
    if (options.dryRun) {
      return {
        goal,
        synthesis: "Dry-run: prompt montado sem chamada LLM.",
        citations,
        gaps,
        dry_run_prompt: prompt,
        ...stubResponse("sucesso", "Síntese dry-run montada."),
      };
    }
    if (!config || config.llm_provider === "none") {
      return {
        goal,
        synthesis: "",
        citations,
        gaps,
        dry_run_prompt: prompt,
        ...stubResponse("parcial", "W_SYNTHESIS_UNAVAILABLE: llm_provider não configurado.", {
          limitations: ["Configure .argus/memory/config.json para habilitar síntese LLM."],
        }),
      };
    }
    try {
      const answer = await createLlmProvider(config).complete(prompt);
      return {
        goal,
        synthesis: answer,
        citations,
        gaps,
        ...stubResponse("sucesso", "Síntese concluída."),
      };
    } catch (err) {
      const message = err instanceof LlmProviderError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
      return {
        goal,
        synthesis: "",
        citations,
        gaps,
        dry_run_prompt: prompt,
        ...stubResponse("parcial", message, { limitations: ["Síntese LLM indisponível; contexto e gaps retornados."] }),
      };
    }
  }
}
