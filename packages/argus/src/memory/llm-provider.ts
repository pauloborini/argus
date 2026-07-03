import {
  DEFAULT_LLM_MODEL_ANTHROPIC,
  DEFAULT_LLM_MODEL_OPENAI,
  type MemoryConfig,
} from "./config.js";

export interface LlmOptions {
  model?: string;
  maxTokens?: number;
}

export interface LlmProvider {
  complete(prompt: string, options?: LlmOptions): Promise<string>;
}

export class LlmProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LlmProviderError";
  }
}

class OpenAiProvider implements LlmProvider {
  constructor(private readonly apiKey: string, private readonly defaultModel?: string) {}

  async complete(prompt: string, options?: LlmOptions): Promise<string> {
    const model = options?.model ?? this.defaultModel ?? DEFAULT_LLM_MODEL_OPENAI;
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) {
      throw new LlmProviderError("E_LLM_FAILED", `OpenAI HTTP ${response.status}: ${await response.text()}`);
    }
    const data = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new LlmProviderError("E_LLM_FAILED", "Formato de resposta inválido da OpenAI.");
    }
    return content;
  }
}

class AnthropicProvider implements LlmProvider {
  constructor(private readonly apiKey: string, private readonly defaultModel?: string) {}

  async complete(prompt: string, options?: LlmOptions): Promise<string> {
    const model = options?.model ?? this.defaultModel ?? DEFAULT_LLM_MODEL_ANTHROPIC;
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: options?.maxTokens ?? 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) {
      throw new LlmProviderError("E_LLM_FAILED", `Anthropic HTTP ${response.status}: ${await response.text()}`);
    }
    const data = await response.json() as { content?: Array<{ text?: unknown }> };
    const content = data.content?.[0]?.text;
    if (typeof content !== "string") {
      throw new LlmProviderError("E_LLM_FAILED", "Formato de resposta inválido da Anthropic.");
    }
    return content;
  }
}

export function createLlmProvider(config: MemoryConfig): LlmProvider {
  if (config.llm_provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY ?? config.openai_api_key;
    if (!apiKey) {
      throw new LlmProviderError("E_MISSING_CREDENTIALS", "OPENAI_API_KEY ausente.");
    }
    return new OpenAiProvider(apiKey, config.llm_model);
  }
  if (config.llm_provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? config.anthropic_api_key;
    if (!apiKey) {
      throw new LlmProviderError("E_MISSING_CREDENTIALS", "ANTHROPIC_API_KEY ausente.");
    }
    return new AnthropicProvider(apiKey, config.llm_model);
  }
  throw new LlmProviderError("E_MISSING_CREDENTIALS", "llm_provider=none.");
}
