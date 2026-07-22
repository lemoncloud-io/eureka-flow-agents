import { api } from '@flows/web-core';

import { GENERATE_TEXT_ONLY, assertGenerateTextOnlyRequest, toGenerateRequestBody } from './generateApiRequest';

import type { ChatRequest, Chunk, LlmGateway } from '@flows/agent';

/**
 * Non-WebSocket eureka-flows-api Generate gateway (P0, "1st) without web-socket"). Implements
 * the shared {@link LlmGateway} `chat()` contract; text-only for now (`capabilities.toolCalls
 * = false`), same as every other Generate/Gemini gateway.
 *
 * Phase 0 real-API verification (see docs/browser-agent/foundations/llm-gateway.md) confirmed
 * that `POST /runs/0/generate` with no `connection`/`transport` params blocks until the model
 * finishes and returns the final answer inline — `output.content` (and a `text` mirror) carry
 * the real result directly, with no async-ACK envelope (`StatusCode`/`$metadata`) and no need
 * for a socket, a `connectionId`, or a WS-frame receiver. That's the whole difference from
 * {@link createGenerateApiLlmGateway}, the WebSocket/SLS variant this gateway sits next to —
 * same request mapping (shared via `./generateApiRequest`), different transport.
 */

export interface GenerateSyncUsage {
    model?: string;
    promptToken?: number;
    completionToken?: number;
    totalToken?: number;
    imageToken?: number;
}

/** The real response shape observed in Phase 0 smoke testing is richer than the gateway needs
 * (`cost`, `candidate`, `version`, `$run`, ...) — kept here for reference/typing but not
 * surfaced through {@link Chunk}, which only supports `text`/`toolCall`/`done`/`usage`. */
export interface GenerateSyncResponse {
    output?: {
        stereo?: string;
        content: string | { data?: string };
    };
    /** Mirrors `output.content` in real responses; used as a fallback if `output.content` is missing. */
    text?: string;
    usage?: GenerateSyncUsage;
    inputTokenCount?: number;
    outputTokenCount?: number;
    totalTokenCount?: number;
    billableInputTokenCount?: number;
    reasoningTokenCount?: number;
    candidate?: unknown;
    cost?: unknown;
    model?: string;
    usageId?: string;
    version?: string;
    $run?: unknown;
}

export type GenerateSyncPostConfig = { signal?: AbortSignal };
export type GenerateSyncPostFn = (
    url: string,
    body: unknown,
    config: GenerateSyncPostConfig
) => Promise<{ data: GenerateSyncResponse }>;

export interface CreateGenerateApiSyncLlmGatewayOptions {
    /** Defaults to `api.post` from `@flows/web-core` (adds `/_api_` + `x-api-key` automatically). */
    post?: GenerateSyncPostFn;
    /** Defaults to `gemini-2.5-flash`. */
    model?: string;
    generation?: { temperature?: number };
}

const DEFAULT_MODEL = 'gemini-2.5-flash';

const defaultPost: GenerateSyncPostFn = (url, body, config) => api.post<GenerateSyncResponse>(url, body, config);

/**
 * The non-WebSocket Generate API gateway: a single `POST /runs/0/generate` with no
 * `connection`/`transport` params, whose response carries the final model answer inline.
 * See the module doc for how this differs from the WebSocket/SLS variant.
 */
export const createGenerateApiSyncLlmGateway = (options: CreateGenerateApiSyncLlmGatewayOptions = {}): LlmGateway => {
    const { post = defaultPost, model = DEFAULT_MODEL, generation } = options;

    async function* chat(req: ChatRequest, opts?: { signal?: AbortSignal }): AsyncIterable<Chunk> {
        assertGenerateTextOnlyRequest(req);

        const body = toGenerateRequestBody(req, model, generation);

        const { data: response } = await post('/runs/0/generate', body, {
            ...(opts?.signal ? { signal: opts.signal } : {}),
        });

        if (opts?.signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        const outputContent = response.output?.content;
        let content: string;
        if (typeof outputContent === 'string') {
            content = outputContent;
        } else if (outputContent === undefined || outputContent === null) {
            if (typeof response.text === 'string') {
                content = response.text;
            } else {
                throw new Error('Generate API response is missing output.content');
            }
        } else {
            throw new Error(`${GENERATE_TEXT_ONLY}: response content is not text (image/object output)`);
        }

        yield { text: content };

        const inputTokens = response.usage?.promptToken ?? response.inputTokenCount;
        const outputTokens = response.usage?.completionToken ?? response.outputTokenCount;
        const usage =
            inputTokens !== undefined || outputTokens !== undefined
                ? {
                      ...(inputTokens !== undefined ? { inputTokens } : {}),
                      ...(outputTokens !== undefined ? { outputTokens } : {}),
                  }
                : undefined;
        yield { done: true, ...(usage ? { usage } : {}) };
    }

    return {
        capabilities: { toolCalls: false },
        chat,
    };
};
