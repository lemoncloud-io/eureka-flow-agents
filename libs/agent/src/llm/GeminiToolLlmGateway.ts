import type { AgentEnvironmentSupportable } from '../environment';
import type { HttpRequestSupportable } from '../http';
import type { ChatRequest, Chunk, JsonSchema, LlmGateway, LlmGatewayCapabilities, ToolDef } from './llmGateway';

/**
 * Tool-capable Gemini gateway — `generateContent` with `functionDeclarations`.
 *
 * Separate from the text-only {@link createGeminiLlmGateway} (which stays as-is): this one
 * declares `capabilities.toolCalls = true`, maps `ToolDef` → Gemini `functionDeclarations`,
 * and parses `candidate.content.parts[].functionCall` back into {@link Chunk} `toolCall`s.
 * Part of provider-native tool-call verification — see
 * docs/browser-agent/foundations/provider-tool-calling.md.
 *
 * Scope A (single turn): request mapping + response parsing. It deliberately does **not** yet
 * map tool-*result* messages back into Gemini `functionResponse` parts — Gemini correlates
 * responses by function *name*, and our tool messages carry only a `toolCallId`, so that
 * round-trip is real Scope-B work. Handed a tool message (or an assistant turn carrying
 * tool calls), this gateway throws loudly rather than guessing.
 */

export interface GeminiToolLlmGatewayOptions {
    /** Provides tracing, time, and cancellation. */
    environment: AgentEnvironmentSupportable;
    /** HTTP port. */
    http: HttpRequestSupportable;
    /** Gemini API key; sent as the x-goog-api-key header, never traced. */
    apiKey: string;
    /** Defaults to gemini-2.5-flash. */
    model?: string;
    /** Override to route through a backend proxy. */
    baseUrl?: string;
    /** Optional generation parameters applied to every request. */
    generation?: { temperature?: number; maxOutputTokens?: number };
}

/** The tool-capable Gemini gateway: the shared contract plus provider/model identity. */
export interface GeminiToolLlmGateway extends LlmGateway {
    readonly capabilities: LlmGatewayCapabilities;
    readonly provider: 'gemini';
    readonly model: string;
}

const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const ERROR_BODY_SNIPPET_LENGTH = 200;
const SCOPE_B =
    'Gemini tool gateway: mapping tool-result / assistant tool-call messages back to functionResponse is not implemented yet (Scope B)';

/** A provider/proxy could echo request data back; scrub the key before it reaches an error. */
const redactText = (value: string, secret: string): string =>
    secret.length > 0 ? value.split(secret).join('[redacted]') : value;

/** JSON-Schema `type` (lowercase) → Gemini's OpenAPI `Type` enum (uppercase). */
const GEMINI_TYPE: Record<string, string> = {
    object: 'OBJECT',
    string: 'STRING',
    number: 'NUMBER',
    integer: 'INTEGER',
    boolean: 'BOOLEAN',
    array: 'ARRAY',
};

/** Recursively convert our JsonSchema to Gemini's schema shape: uppercase `type`, recurse into properties/items. */
const toGeminiSchema = (schema: JsonSchema): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...schema };
    if (typeof schema.type === 'string' && GEMINI_TYPE[schema.type]) {
        out['type'] = GEMINI_TYPE[schema.type];
    }
    if (schema.properties) {
        out['properties'] = Object.fromEntries(
            Object.entries(schema.properties).map(([key, value]) => [key, toGeminiSchema(value)])
        );
    }
    if (schema.items) {
        out['items'] = toGeminiSchema(schema.items);
    }
    return out;
};

interface GeminiContent {
    role: 'user' | 'model';
    parts: Array<{ text: string }>;
}

const toGeminiTool = (tool: ToolDef) => ({
    name: tool.name,
    description: tool.description,
    parameters: toGeminiSchema(tool.parameters),
});

/** Map the provider-neutral request onto Gemini's generateContent shape with function declarations. */
const toGeminiToolRequest = (req: ChatRequest, generation?: GeminiToolLlmGatewayOptions['generation']) => {
    const systemTexts: string[] = [];
    const contents: GeminiContent[] = [];

    for (const message of req.messages) {
        if (message.role === 'tool' || (message.toolCalls?.length ?? 0) > 0) {
            throw new Error(SCOPE_B);
        }
        if (message.role === 'system') {
            systemTexts.push(message.content ?? '');
            continue;
        }
        contents.push({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content ?? '' }],
        });
    }

    const generationConfig = {
        ...(generation?.temperature !== undefined ? { temperature: generation.temperature } : {}),
        ...(generation?.maxOutputTokens !== undefined ? { maxOutputTokens: generation.maxOutputTokens } : {}),
    };

    return {
        contents,
        ...(systemTexts.length > 0 ? { systemInstruction: { parts: [{ text: systemTexts.join('\n\n') }] } } : {}),
        ...(req.tools.length > 0 ? { tools: [{ functionDeclarations: req.tools.map(toGeminiTool) }] } : {}),
        ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
    };
};

interface GeminiToolResponse {
    candidates?: Array<{
        content?: { parts?: Array<{ text?: string; functionCall?: { name: string; args?: unknown } }> };
    }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/** LlmGateway backed by Gemini's generateContent API with function calling; declares `toolCalls: true`. */
export const createGeminiToolLlmGateway = (options: GeminiToolLlmGatewayOptions): GeminiToolLlmGateway => {
    const { environment, http, apiKey } = options;
    const model = options.model ?? DEFAULT_MODEL;
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    const trace = environment.traceReporter;

    async function* chat(req: ChatRequest, opts?: { signal?: AbortSignal }): AsyncIterable<Chunk> {
        const startedAt = environment.now();
        const body = toGeminiToolRequest(req, options.generation);

        trace?.debug('llm.gemini.request', { model, messageCount: req.messages.length, toolCount: req.tools.length });

        const response = await http.request({
            method: 'POST',
            url: `${baseUrl}/v1beta/models/${model}:generateContent`,
            headers: { 'x-goog-api-key': apiKey },
            body,
            ...(opts?.signal ? { signal: opts.signal } : {}),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => '');
            const safeBody = redactText(errorBody, apiKey);

            trace?.error('llm.gemini.error', { model, status: response.status });
            throw new Error(
                `Gemini request failed with status ${response.status}: ${safeBody.slice(0, ERROR_BODY_SNIPPET_LENGTH)}`
            );
        }

        const payload = (await response.json()) as GeminiToolResponse;
        const parts = payload.candidates?.[0]?.content?.parts;

        if (!parts || parts.length === 0) {
            trace?.error('llm.gemini.error', { model, status: response.status, reason: 'no candidates' });
            throw new Error('Gemini response contained no candidates');
        }

        let text = '';
        const functionCalls: Array<{ name: string; args: unknown }> = [];
        for (const part of parts) {
            if (part.text) {
                text += part.text;
            }
            if (part.functionCall) {
                functionCalls.push({ name: part.functionCall.name, args: part.functionCall.args ?? {} });
            }
        }

        const usage = payload.usageMetadata
            ? {
                  ...(payload.usageMetadata.promptTokenCount !== undefined
                      ? { inputTokens: payload.usageMetadata.promptTokenCount }
                      : {}),
                  ...(payload.usageMetadata.candidatesTokenCount !== undefined
                      ? { outputTokens: payload.usageMetadata.candidatesTokenCount }
                      : {}),
              }
            : undefined;

        trace?.debug('llm.gemini.response', {
            model,
            status: response.status,
            textLength: text.length,
            toolCallCount: functionCalls.length,
            durationMs: environment.now() - startedAt,
            ...(usage ? { usage } : {}),
        });

        if (text) {
            yield { text };
        }
        // Gemini provides no call id; generate a turn-local one (collect() only needs turn uniqueness).
        let callSeq = 0;
        for (const call of functionCalls) {
            callSeq += 1;
            yield { toolCall: { id: `gemini-call-${callSeq}`, name: call.name, argsDelta: JSON.stringify(call.args) } };
        }
        yield { done: true, ...(usage ? { usage } : {}) };
    }

    return {
        capabilities: { toolCalls: true },
        provider: 'gemini',
        model,
        chat,
    };
};
