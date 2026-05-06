/**
 * LLM client for an OpenAI-compatible endpoint (llama.cpp).
 *
 * Two methods, picked by intent at the call site:
 *   - fast(messages)   sends enable_thinking: false   (sub-second, used for high-frequency calls)
 *   - deep(messages)   sends enable_thinking: true    (with reasoning, used for synthesis)
 *
 * Uses plain `fetch` to keep full control over headers — Cloudflare in front of
 * ai.mayoq.tech blocks the OpenAI SDK's default User-Agent.
 *
 * Emits one `llm.fast` or `llm.deep` event per call (success or failure) for L1 visibility.
 */

import { events } from './events.ts';

export type Role = 'system' | 'user' | 'assistant';

export type Message = {
  role: Role;
  content: string;
};

export type LlmCallOptions = {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  /** Pass-through to the upstream `response_format` field (OpenAI-compatible). */
  responseFormat?: unknown;
};

export type LlmResponse = {
  content: string;
  reasoning: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  latencyMs: number;
};

const USER_AGENT = 'Mozilla/5.0';

class LlmClient {
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor() {
    const baseURL = process.env.LLM_BASE_URL?.trim();
    const apiKey = process.env.LLM_API_KEY?.trim();
    const model = process.env.LLM_MODEL?.trim();

    if (!baseURL) {
      throw new Error(
        'LLM_BASE_URL is not set. Copy .env.example to .env and fill it in.',
      );
    }
    if (!apiKey) {
      throw new Error(
        'LLM_API_KEY is not set. Copy .env.example to .env and fill it in.',
      );
    }
    if (!model) {
      throw new Error(
        'LLM_MODEL is not set. Copy .env.example to .env and fill it in.',
      );
    }

    this.baseURL = baseURL.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.model = model;
  }

  fast(messages: Message[], opts: LlmCallOptions = {}): Promise<LlmResponse> {
    return this.dispatch(messages, opts, false);
  }

  deep(messages: Message[], opts: LlmCallOptions = {}): Promise<LlmResponse> {
    return this.dispatch(messages, opts, true);
  }

  private async dispatch(
    messages: Message[],
    opts: LlmCallOptions,
    enableThinking: boolean,
  ): Promise<LlmResponse> {
    const kind = enableThinking ? 'llm.deep' : 'llm.fast';
    const lastUserMessage =
      [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const promptPreview = lastUserMessage.slice(0, 80);

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.7,
      top_p: opts.topP ?? 0.95,
      stop: opts.stop,
      stream: false,
      chat_template_kwargs: { enable_thinking: enableThinking },
    };
    if (opts.responseFormat !== undefined) {
      body.response_format = opts.responseFormat;
    }

    const startedAt = performance.now();
    let res: Response;
    try {
      res = await fetch(`${this.baseURL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const durationMs = Math.round(performance.now() - startedAt);
      await events.emit({
        kind,
        layer: 'L0',
        durationMs,
        payload: { prompt: promptPreview, error: (err as Error).message },
      });
      throw err;
    }
    const latencyMs = performance.now() - startedAt;

    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 500);
      await events.emit({
        kind,
        layer: 'L0',
        durationMs: Math.round(latencyMs),
        payload: { prompt: promptPreview, error: `HTTP ${res.status} — ${text}` },
      });
      throw new Error(`LLM request failed: HTTP ${res.status} — ${text}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string; reasoning_content?: string };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };

    const choice = data.choices?.[0]?.message;
    if (!choice) {
      await events.emit({
        kind,
        layer: 'L0',
        durationMs: Math.round(latencyMs),
        payload: { prompt: promptPreview, error: 'no choices in response' },
      });
      throw new Error(
        `LLM response had no choices: ${JSON.stringify(data).slice(0, 300)}`,
      );
    }

    const usage = {
      prompt_tokens: data.usage?.prompt_tokens ?? 0,
      completion_tokens: data.usage?.completion_tokens ?? 0,
      total_tokens: data.usage?.total_tokens ?? 0,
    };

    await events.emit({
      kind,
      layer: 'L0',
      durationMs: Math.round(latencyMs),
      payload: { prompt: promptPreview, ...usage },
    });

    return {
      content: choice.content ?? '',
      reasoning: choice.reasoning_content ?? '',
      usage,
      latencyMs: Math.round(latencyMs),
    };
  }
}

let _client: LlmClient | null = null;

/**
 * Lazy singleton. Importing this module does NOT validate env;
 * the env check fires on first method call.
 */
export const llm = {
  fast: (messages: Message[], opts?: LlmCallOptions) =>
    (_client ??= new LlmClient()).fast(messages, opts),
  deep: (messages: Message[], opts?: LlmCallOptions) =>
    (_client ??= new LlmClient()).deep(messages, opts),
};

export { LlmClient };
