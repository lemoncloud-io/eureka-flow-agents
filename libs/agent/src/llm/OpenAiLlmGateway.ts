import type { AgentEnvironmentSupportable } from '../environment';
import type { HttpRequestSupportable } from '../http';
import type { ChatMessage, ChatRequest, Chunk, LlmGateway, LlmGatewayCapabilities, ToolDef } from './llmGateway';

/**
 * OpenAI Chat Completions gateway — the first *tool-capable* real-provider gateway.
 *
 * Steve's clarification (see docs/browser-agent/foundations/provider-tool-calling.md): the
 * eureka-flows-api Generate endpoint is text-only and not designed for tool calling, so
 * structured tool-call verification runs directly against provider APIs behind the shared
 * {@link LlmGateway} contract. This gateway declares `capabilities.toolCalls = true` and maps
 * `ToolDef` → OpenAI `tools` / parses `tool_calls` back into {@link Chunk} `toolCall`s.
 *
 * OpenRouter is OpenAI-wire-compatible: point `baseUrl` at `https://openrouter.ai/api/v1`,
 * pass an OpenRouter key + model id, and this same gateway serves it.
 *
 * Non-streaming: one HTTP call, the whole response mapped to chunks — a tool call's full
 * arguments JSON is emitted as a single `argsDelta`, which `BaseAgent.collect()` accumulates
 * and JSON-parses exactly as it does the fake gateway's output.
 */

export interface OpenAiLlmGatewayOptions {
    /** Provides tracing, time, and cancellation. */
    environment: AgentEnvironmentSupportable;
    /** HTTP port. */
    http: HttpRequestSupportable;
    /** API key; sent as the `Authorization: Bearer` header, never traced. */
    apiKey: string;
    /** Defaults to `gpt-4o-mini` (a real, cheap, tool-capable OpenAI model). */
    model?: string;
    /** Override to point at OpenRouter (`https://openrouter.ai/api/v1`) or a proxy. Defaults to the OpenAI API. */
    baseUrl?: string;
    /** Optional generation parameters applied to every request. */
    generation?: { temperature?: number; maxOutputTokens?: number };
}

/** The OpenAI gateway: the shared contract plus provider/model identity. Tool-capable. */
export interface OpenAiLlmGateway extends LlmGateway {
    readonly capabilities: LlmGatewayCapabilities;
    readonly provider: 'openai';
    readonly model: string;
}

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const ERROR_BODY_SNIPPET_LENGTH = 200;

/** A provider/proxy could echo request data back; scrub the key before it reaches an error. */
const redactText = (value: string, secret: string): string =>
    secret.length > 0 ? value.split(secret).join('[redacted]') : value;

interface OpenAiToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

interface OpenAiMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: OpenAiToolCall[];
    tool_call_id?: string;
}

/** Map one provider-neutral chat message onto an OpenAI Chat Completions message. */
const toOpenAiMessage = (message: ChatMessage): OpenAiMessage => {
    if (message.role === 'tool') {
        return { role: 'tool', content: message.content ?? '', tool_call_id: message.toolCallId };
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
        return {
            role: 'assistant',
            content: message.content ?? null,
            // Our `args` is already the raw JSON string OpenAI expects for `arguments`.
            tool_calls: message.toolCalls.map(tc => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: tc.args },
            })),
        };
    }
    return { role: message.role, content: message.content ?? null };
};

const toOpenAiTool = (tool: ToolDef) => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
});

const toOpenAiRequestBody = (req: ChatRequest, model: string, generation?: OpenAiLlmGatewayOptions['generation']) => ({
    model,
    messages: req.messages.map(toOpenAiMessage),
    ...(req.tools.length > 0 ? { tools: req.tools.map(toOpenAiTool), tool_choice: 'auto' } : {}),
    ...(generation?.temperature !== undefined ? { temperature: generation.temperature } : {}),
    ...(generation?.maxOutputTokens !== undefined ? { max_tokens: generation.maxOutputTokens } : {}),
});

interface OpenAiResponse {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: OpenAiToolCall[] } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** LlmGateway backed by OpenAI's Chat Completions API; tool-capable (declares `toolCalls: true`). */
export const createOpenAiLlmGateway = (options: OpenAiLlmGatewayOptions): OpenAiLlmGateway => {
    const { environment, http, apiKey } = options;
    const model = options.model ?? DEFAULT_MODEL;
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    const trace = environment.traceReporter;

    async function* chat(req: ChatRequest, opts?: { signal?: AbortSignal }): AsyncIterable<Chunk> {
        const startedAt = environment.now();
        const body = toOpenAiRequestBody(req, model, options.generation);

        trace?.debug('llm.openai.request', {
            model,
            messageCount: req.messages.length,
            toolCount: req.tools.length,
        });

        const response = await http.request({
            method: 'POST',
            url: `${baseUrl}/chat/completions`,
            headers: { authorization: `Bearer ${apiKey}` },
            body,
            ...(opts?.signal ? { signal: opts.signal } : {}),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => '');
            const safeBody = redactText(errorBody, apiKey);

            trace?.error('llm.openai.error', { model, status: response.status });
            throw new Error(
                `OpenAI request failed with status ${response.status}: ${safeBody.slice(0, ERROR_BODY_SNIPPET_LENGTH)}`
            );
        }

        const payload = (await response.json()) as OpenAiResponse;
        const message = payload.choices?.[0]?.message;

        if (!message) {
            trace?.error('llm.openai.error', { model, status: response.status, reason: 'no choices' });
            throw new Error('OpenAI response contained no choices');
        }

        const toolCalls = message.tool_calls ?? [];
        const usage = payload.usage
            ? {
                  ...(payload.usage.prompt_tokens !== undefined ? { inputTokens: payload.usage.prompt_tokens } : {}),
                  ...(payload.usage.completion_tokens !== undefined
                      ? { outputTokens: payload.usage.completion_tokens }
                      : {}),
              }
            : undefined;

        trace?.debug('llm.openai.response', {
            model,
            status: response.status,
            hasText: typeof message.content === 'string' && message.content.length > 0,
            toolCallCount: toolCalls.length,
            durationMs: environment.now() - startedAt,
            ...(usage ? { usage } : {}),
        });

        // A tool-call turn legitimately has `content: null` — unlike the text-only gateways,
        // an empty content field here is not an error.
        if (typeof message.content === 'string' && message.content.length > 0) {
            yield { text: message.content };
        }
        for (const call of toolCalls) {
            yield { toolCall: { id: call.id, name: call.function.name, argsDelta: call.function.arguments } };
        }
        yield { done: true, ...(usage ? { usage } : {}) };
    }

    return {
        capabilities: { toolCalls: true },
        provider: 'openai',
        model,
        chat,
    };
};
