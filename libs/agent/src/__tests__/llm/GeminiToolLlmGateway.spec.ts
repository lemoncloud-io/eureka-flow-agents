import { describe, expect, it } from 'vitest';

import { createCanvasToolProvider } from '../../canvas/canvasTools';
import { createInMemoryCanvasBinding } from '../../canvas/inMemoryCanvasBinding';
import { createVirtualAgentEnvironment } from '../../environment/createVirtualAgentEnvironment';
import { BufferAgentTraceReporter } from '../../environment/trace/traceReporters';
import { ScriptedHttpRequest } from '../../http/ScriptedHttpRequest';
import { createGeminiToolLlmGateway } from '../../llm/GeminiToolLlmGateway';
import { createToolExecutor } from '../../tools/toolExecutor';

import type { AgentConfig } from '../../agent';
import type { Chunk } from '../../llm/llmGateway';
import type { NodeData } from '@lemoncloud/eureka-flows-api';

const API_KEY = 'test-gemini-key';

/** A canned Gemini text reply. */
const geminiText = (text: string) => ({
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 34 },
});

/** A canned Gemini function-call reply. `args` is a parsed object (Gemini's native shape). */
const geminiFunctionCall = (name: string, args: unknown) => ({
    candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8 },
});

const createGateway = (http: ScriptedHttpRequest, traceReporter?: BufferAgentTraceReporter) =>
    createGeminiToolLlmGateway({
        environment: createVirtualAgentEnvironment({ ...(traceReporter ? { traceReporter } : {}), now: () => 1000 }),
        http,
        apiKey: API_KEY,
    });

const drain = async (stream: AsyncIterable<Chunk>): Promise<Chunk[]> => {
    const chunks: Chunk[] = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return chunks;
};

const userSays = (content: string) => ({ messages: [{ role: 'user' as const, content }], tools: [] });

const makeNode = (id: string, x: number, y: number, extra: Partial<NodeData> = {}): NodeData => ({
    id,
    type: 'test',
    position: { x, y },
    ...extra,
});

describe('createGeminiToolLlmGateway', () => {
    it('declares itself a tool-capable gemini gateway with the default model', () => {
        const gateway = createGateway(new ScriptedHttpRequest());

        expect(gateway.capabilities).toEqual({ toolCalls: true });
        expect(gateway.provider).toBe('gemini');
        expect(gateway.model).toBe('gemini-2.5-flash');
    });

    it('authenticates via header, never the URL, and posts to generateContent', async () => {
        const http = new ScriptedHttpRequest([{ json: geminiText('hi') }]);

        await drain(createGateway(http).chat(userSays('hello')));

        const request = http.requests[0];
        expect(request.method).toBe('POST');
        expect(request.url).toBe(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
        );
        expect(request.url).not.toContain(API_KEY);
        expect(request.headers?.['x-goog-api-key']).toBe(API_KEY);
    });

    it('maps ToolDef into functionDeclarations with UPPERCASE schema types (recursively)', async () => {
        const http = new ScriptedHttpRequest([{ json: geminiText('ok') }]);

        await drain(
            createGateway(http).chat({
                messages: [{ role: 'user', content: 'move it' }],
                tools: [
                    {
                        name: 'move_node',
                        description: 'move a node',
                        parameters: {
                            type: 'object',
                            properties: {
                                nodeId: { type: 'string' },
                                by: {
                                    type: 'object',
                                    properties: { dx: { type: 'number' }, dy: { type: 'number' } },
                                    required: ['dx', 'dy'],
                                },
                            },
                            required: ['nodeId'],
                        },
                    },
                ],
            })
        );

        const body = http.requests[0].body as Record<string, unknown>;
        expect(body['tools']).toEqual([
            {
                functionDeclarations: [
                    {
                        name: 'move_node',
                        description: 'move a node',
                        parameters: {
                            type: 'OBJECT',
                            properties: {
                                nodeId: { type: 'STRING' },
                                by: {
                                    type: 'OBJECT',
                                    properties: { dx: { type: 'NUMBER' }, dy: { type: 'NUMBER' } },
                                    required: ['dx', 'dy'],
                                },
                            },
                            required: ['nodeId'],
                        },
                    },
                ],
            },
        ]);
    });

    it('maps system messages to systemInstruction and omits tools when none are given', async () => {
        const http = new ScriptedHttpRequest([{ json: geminiText('ok') }]);

        await drain(
            createGateway(http).chat({
                messages: [
                    { role: 'system', content: 'be brief' },
                    { role: 'user', content: 'q' },
                ],
                tools: [],
            })
        );

        const body = http.requests[0].body as Record<string, unknown>;
        expect(body['systemInstruction']).toEqual({ parts: [{ text: 'be brief' }] });
        expect(body).not.toHaveProperty('tools');
    });

    it('yields a text chunk then a done chunk carrying usage', async () => {
        const http = new ScriptedHttpRequest([{ json: geminiText('the answer') }]);

        const chunks = await drain(createGateway(http).chat(userSays('q')));

        expect(chunks).toEqual([{ text: 'the answer' }, { done: true, usage: { inputTokens: 12, outputTokens: 34 } }]);
    });

    it('parses a functionCall part into a toolCall chunk (args object → JSON string argsDelta)', async () => {
        const http = new ScriptedHttpRequest([
            { json: geminiFunctionCall('move_node', { nodeId: 'text-1', by: { dx: 100, dy: 0 } }) },
        ]);

        const chunks = await drain(createGateway(http).chat(userSays('move the text input 100 right')));

        expect(chunks).toEqual([
            {
                toolCall: {
                    id: 'gemini-call-1',
                    name: 'move_node',
                    argsDelta: '{"nodeId":"text-1","by":{"dx":100,"dy":0}}',
                },
            },
            { done: true, usage: { inputTokens: 20, outputTokens: 8 } },
        ]);
    });

    it('throws a clear Scope-B error on tool-result or assistant tool-call messages', async () => {
        const gateway = createGateway(new ScriptedHttpRequest());

        await expect(
            drain(gateway.chat({ messages: [{ role: 'tool', content: '{}', toolCallId: 'c1' }], tools: [] }))
        ).rejects.toThrow(/Scope B/);

        await expect(
            drain(
                gateway.chat({
                    messages: [
                        { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'move_node', args: '{}' }] },
                    ],
                    tools: [],
                })
            )
        ).rejects.toThrow(/Scope B/);
    });

    it('honors model and baseUrl overrides (the proxy path)', async () => {
        const http = new ScriptedHttpRequest([{ json: geminiText('ok') }]);
        const gateway = createGeminiToolLlmGateway({
            environment: createVirtualAgentEnvironment(),
            http,
            apiKey: API_KEY,
            model: 'gemini-2.5-pro',
            baseUrl: 'https://proxy.internal/gemini',
        });

        await drain(gateway.chat(userSays('q')));

        expect(http.requests[0].url).toBe('https://proxy.internal/gemini/v1beta/models/gemini-2.5-pro:generateContent');
    });

    it('passes the abort signal through to the HTTP port', async () => {
        const http = new ScriptedHttpRequest([{ json: geminiText('ok') }]);
        const controller = new AbortController();

        await drain(createGateway(http).chat(userSays('q'), { signal: controller.signal }));

        expect(http.requests[0].signal).toBe(controller.signal);
    });

    it('throws on non-ok responses with the status but never the API key, and traces the error', async () => {
        const http = new ScriptedHttpRequest([{ status: 400, text: `bad key ${API_KEY}` }]);
        const trace = new BufferAgentTraceReporter();

        const attempt = drain(createGateway(http, trace).chat(userSays('q')));

        await expect(attempt).rejects.toThrow(/status 400.*bad key \[redacted\]/);
        await attempt.catch((error: Error) => expect(error.message).not.toContain(API_KEY));
        expect(trace.entries.some(entry => entry.level === 'error')).toBe(true);
        expect(JSON.stringify(trace.entries)).not.toContain(API_KEY);
    });

    it('throws when the response has no candidates', async () => {
        const http = new ScriptedHttpRequest([{ json: { candidates: [] } }]);

        await expect(drain(createGateway(http).chat(userSays('q')))).rejects.toThrow(/no candidates/);
    });

    it('traces request and response without leaking the key', async () => {
        const http = new ScriptedHttpRequest([{ json: geminiText('traced') }]);
        const trace = new BufferAgentTraceReporter();

        await drain(createGateway(http, trace).chat(userSays('q')));

        const messages = trace.entries.map(entry => entry.message);
        expect(messages).toContain('llm.gemini.request');
        expect(messages).toContain('llm.gemini.response');
        expect(JSON.stringify(trace.entries)).not.toContain(API_KEY);
    });

    // The full offline chain: a canned Gemini functionCall flows through the gateway's parsing
    // into a Chunk.toolCall, then through the real ToolExecutor + canvas tools, moving the node.
    it('canned functionCall response drives ToolExecutor to move the node (100,200) -> (200,200)', async () => {
        const binding = createInMemoryCanvasBinding({
            nodes: [makeNode('text-1', 100, 200, { type: 'text-input' })],
            edges: [],
        });
        const provider = createCanvasToolProvider(binding);
        const executor = createToolExecutor();
        const config: AgentConfig = {
            id: 'locator-test',
            description: 'moves nodes',
            systemPrompt: 'move nodes on the canvas',
            tools: [provider],
            grant: { canModifyCanvas: true },
        };

        const http = new ScriptedHttpRequest([
            { json: geminiFunctionCall('move_node', { nodeId: 'text-1', by: { dx: 100, dy: 0 } }) },
        ]);

        const chunks = await drain(
            createGateway(http).chat({
                messages: [{ role: 'user', content: 'Move the text input node 100px to the right.' }],
                tools: await executor.listTools(config),
            })
        );

        const toolCall = chunks.find(c => c.toolCall)?.toolCall;
        expect(toolCall?.name).toBe('move_node');

        const result = await executor.dispatch(config, {
            id: toolCall!.id,
            name: toolCall!.name,
            args: JSON.parse(toolCall!.argsDelta),
        });

        expect(result.ok).toBe(true);
        expect(binding.readGraph().nodes[0].position).toEqual({ x: 200, y: 200 });
    });
});
