import { describe, expect, it } from 'vitest';

import { createCanvasToolProvider } from '../../canvas/canvasTools';
import { createInMemoryCanvasBinding } from '../../canvas/inMemoryCanvasBinding';
import { createVirtualAgentEnvironment } from '../../environment/createVirtualAgentEnvironment';
import { BufferAgentTraceReporter } from '../../environment/trace/traceReporters';
import { ScriptedHttpRequest } from '../../http/ScriptedHttpRequest';
import { createOpenAiLlmGateway } from '../../llm/OpenAiLlmGateway';
import { createToolExecutor } from '../../tools/toolExecutor';

import type { AgentConfig } from '../../agent';
import type { Chunk } from '../../llm/llmGateway';
import type { NodeData } from '@lemoncloud/eureka-flows-api';

const API_KEY = 'test-openai-key';

/** A canned OpenAI text reply. */
const openAiText = (content: string) => ({
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 12, completion_tokens: 34 },
});

/** A canned OpenAI tool-call reply (content null, one function call). `args` is a JSON string. */
const openAiToolCall = (id: string, name: string, args: string) => ({
    choices: [
        {
            message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
            },
        },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 8 },
});

const createGateway = (http: ScriptedHttpRequest, traceReporter?: BufferAgentTraceReporter) =>
    createOpenAiLlmGateway({
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

describe('createOpenAiLlmGateway', () => {
    it('declares itself a tool-capable openai gateway with the default model', () => {
        const gateway = createGateway(new ScriptedHttpRequest());

        expect(gateway.capabilities).toEqual({ toolCalls: true });
        expect(gateway.provider).toBe('openai');
        expect(gateway.model).toBe('gpt-4o-mini');
    });

    it('authenticates via the Authorization header, never the URL, and posts to /chat/completions', async () => {
        const http = new ScriptedHttpRequest([{ json: openAiText('hi') }]);

        await drain(createGateway(http).chat(userSays('hello')));

        const request = http.requests[0];
        expect(request.method).toBe('POST');
        expect(request.url).toBe('https://api.openai.com/v1/chat/completions');
        expect(request.url).not.toContain(API_KEY);
        expect(request.headers?.['authorization']).toBe(`Bearer ${API_KEY}`);
    });

    it('maps system/user/assistant/tool messages and tool definitions into the OpenAI request shape', async () => {
        const http = new ScriptedHttpRequest([{ json: openAiText('ok') }]);

        await drain(
            createGateway(http).chat({
                messages: [
                    { role: 'system', content: 'be brief' },
                    { role: 'user', content: 'move it' },
                    {
                        role: 'assistant',
                        content: null,
                        toolCalls: [{ id: 'c1', name: 'move_node', args: '{"nodeId":"n1"}' }],
                    },
                    { role: 'tool', content: '{"ok":true}', toolCallId: 'c1' },
                ],
                tools: [
                    { name: 'move_node', description: 'move a node', parameters: { type: 'object', properties: {} } },
                ],
            })
        );

        const body = http.requests[0].body as Record<string, unknown>;
        expect(body['messages']).toEqual([
            { role: 'system', content: 'be brief' },
            { role: 'user', content: 'move it' },
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    { id: 'c1', type: 'function', function: { name: 'move_node', arguments: '{"nodeId":"n1"}' } },
                ],
            },
            { role: 'tool', content: '{"ok":true}', tool_call_id: 'c1' },
        ]);
        expect(body['tools']).toEqual([
            {
                type: 'function',
                function: {
                    name: 'move_node',
                    description: 'move a node',
                    parameters: { type: 'object', properties: {} },
                },
            },
        ]);
        expect(body['tool_choice']).toBe('auto');
    });

    it('omits tools and tool_choice when the request carries no tools', async () => {
        const http = new ScriptedHttpRequest([{ json: openAiText('ok') }]);

        await drain(createGateway(http).chat(userSays('q')));

        const body = http.requests[0].body as Record<string, unknown>;
        expect(body).not.toHaveProperty('tools');
        expect(body).not.toHaveProperty('tool_choice');
    });

    it('maps generation params into temperature and max_tokens', async () => {
        const http = new ScriptedHttpRequest([{ json: openAiText('ok') }]);
        const gateway = createOpenAiLlmGateway({
            environment: createVirtualAgentEnvironment(),
            http,
            apiKey: API_KEY,
            generation: { temperature: 0.2, maxOutputTokens: 64 },
        });

        await drain(gateway.chat(userSays('q')));

        const body = http.requests[0].body as Record<string, unknown>;
        expect(body['temperature']).toBe(0.2);
        expect(body['max_tokens']).toBe(64);
    });

    it('yields a text chunk then a done chunk carrying usage', async () => {
        const http = new ScriptedHttpRequest([{ json: openAiText('the answer') }]);

        const chunks = await drain(createGateway(http).chat(userSays('q')));

        expect(chunks).toEqual([{ text: 'the answer' }, { done: true, usage: { inputTokens: 12, outputTokens: 34 } }]);
    });

    it('parses a tool-call response (content null) into a toolCall chunk, no error on empty content', async () => {
        const http = new ScriptedHttpRequest([
            { json: openAiToolCall('call_1', 'move_node', '{"nodeId":"text-1","by":{"dx":100,"dy":0}}') },
        ]);

        const chunks = await drain(createGateway(http).chat(userSays('move the text input 100 right')));

        expect(chunks).toEqual([
            { toolCall: { id: 'call_1', name: 'move_node', argsDelta: '{"nodeId":"text-1","by":{"dx":100,"dy":0}}' } },
            { done: true, usage: { inputTokens: 20, outputTokens: 8 } },
        ]);
    });

    it('honors model and baseUrl overrides (the OpenRouter / proxy path)', async () => {
        const http = new ScriptedHttpRequest([{ json: openAiText('ok') }]);
        const gateway = createOpenAiLlmGateway({
            environment: createVirtualAgentEnvironment(),
            http,
            apiKey: API_KEY,
            model: 'openai/gpt-4o-mini',
            baseUrl: 'https://openrouter.ai/api/v1',
        });

        await drain(gateway.chat(userSays('q')));

        expect(http.requests[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
        expect((http.requests[0].body as Record<string, unknown>)['model']).toBe('openai/gpt-4o-mini');
    });

    it('passes the abort signal through to the HTTP port', async () => {
        const http = new ScriptedHttpRequest([{ json: openAiText('ok') }]);
        const controller = new AbortController();

        await drain(createGateway(http).chat(userSays('q'), { signal: controller.signal }));

        expect(http.requests[0].signal).toBe(controller.signal);
    });

    it('throws on non-ok responses with the status but never the API key, and traces the error', async () => {
        const http = new ScriptedHttpRequest([{ status: 401, text: `invalid key ${API_KEY}` }]);
        const trace = new BufferAgentTraceReporter();

        const attempt = drain(createGateway(http, trace).chat(userSays('q')));

        await expect(attempt).rejects.toThrow(/status 401.*invalid key \[redacted\]/);
        await attempt.catch((error: Error) => expect(error.message).not.toContain(API_KEY));
        expect(trace.entries.some(entry => entry.level === 'error')).toBe(true);
        expect(JSON.stringify(trace.entries)).not.toContain(API_KEY);
    });

    it('throws when the response has no choices', async () => {
        const http = new ScriptedHttpRequest([{ json: { choices: [] } }]);

        await expect(drain(createGateway(http).chat(userSays('q')))).rejects.toThrow(/no choices/);
    });

    it('traces request and response without leaking the key', async () => {
        const http = new ScriptedHttpRequest([{ json: openAiText('traced') }]);
        const trace = new BufferAgentTraceReporter();

        await drain(createGateway(http, trace).chat(userSays('q')));

        const messages = trace.entries.map(entry => entry.message);
        expect(messages).toContain('llm.openai.request');
        expect(messages).toContain('llm.openai.response');
        expect(JSON.stringify(trace.entries)).not.toContain(API_KEY);
    });

    // The full offline chain: a canned OpenAI tool-call response flows through the gateway's
    // parsing into a Chunk.toolCall, then through the real ToolExecutor + canvas tools, and
    // moves the node — the same bar the real env-gated test proves against a live provider,
    // but deterministic (no key, no network).
    it('canned tool-call response drives ToolExecutor to move the node (100,200) -> (200,200)', async () => {
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
            { json: openAiToolCall('call_1', 'move_node', '{"nodeId":"text-1","by":{"dx":100,"dy":0}}') },
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
