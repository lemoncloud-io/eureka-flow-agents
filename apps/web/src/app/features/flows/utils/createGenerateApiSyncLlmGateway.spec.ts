import { describe, expect, it, vi } from 'vitest';

import { createGenerateApiSyncLlmGateway } from './createGenerateApiSyncLlmGateway';

import type {
    CreateGenerateApiSyncLlmGatewayOptions,
    GenerateSyncPostFn,
    GenerateSyncResponse,
} from './createGenerateApiSyncLlmGateway';
import type { ChatRequest, Chunk } from '@flows/agent';

const drain = async (stream: AsyncIterable<Chunk>): Promise<Chunk[]> => {
    const chunks: Chunk[] = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return chunks;
};

const textResponse = (text: string): GenerateSyncResponse => ({ output: { content: text } });

const makeFakePost = (
    response: GenerateSyncResponse
): { post: GenerateSyncPostFn; post$: ReturnType<typeof vi.fn> } => {
    const post$ = vi.fn().mockResolvedValue({ data: response });
    return { post: post$ as unknown as GenerateSyncPostFn, post$ };
};

const createGateway = (overrides: Partial<CreateGenerateApiSyncLlmGatewayOptions>, post: GenerateSyncPostFn) =>
    createGenerateApiSyncLlmGateway({ post, ...overrides });

const userSays = (content: string): ChatRequest => ({ messages: [{ role: 'user', content }], tools: [] });

// This gateway has no connection/socket concept at all (that's the whole point of the P0,
// non-WebSocket path) — unlike createGenerateApiLlmGateway's spec, there is no readiness-guard
// describe block here: nothing to be "not ready" about.
describe('createGenerateApiSyncLlmGateway', () => {
    it('declares itself text-only', () => {
        const { post } = makeFakePost(textResponse('x'));
        const gateway = createGateway({}, post);
        expect(gateway.capabilities).toEqual({ toolCalls: false });
    });

    describe('request mapping', () => {
        it('maps a single user message to a plain string prompt', async () => {
            const { post, post$ } = makeFakePost(textResponse('ok'));
            const gateway = createGateway({}, post);

            await drain(gateway.chat(userSays('hello there')));

            const body = post$.mock.calls[0][1];
            expect(body.prompt).toBe('hello there');
        });

        it('maps multi-turn user/assistant messages to GenerateContent[], assistant as model role', async () => {
            const { post, post$ } = makeFakePost(textResponse('ok'));
            const gateway = createGateway({}, post);

            await drain(
                gateway.chat({
                    messages: [
                        { role: 'user', content: 'question' },
                        { role: 'assistant', content: 'earlier answer' },
                        { role: 'user', content: 'follow-up' },
                    ],
                    tools: [],
                })
            );

            const body = post$.mock.calls[0][1];
            expect(body.prompt).toEqual({
                content: [
                    { role: 'user', parts: [{ text: 'question' }] },
                    { role: 'model', parts: [{ text: 'earlier answer' }] },
                    { role: 'user', parts: [{ text: 'follow-up' }] },
                ],
            });
        });

        it('joins system messages with \\n\\n into GenerateRequestBody.system', async () => {
            const { post, post$ } = makeFakePost(textResponse('ok'));
            const gateway = createGateway({}, post);

            await drain(
                gateway.chat({
                    messages: [
                        { role: 'system', content: 'be brief' },
                        { role: 'system', content: 'answer in English' },
                        { role: 'user', content: 'hi' },
                    ],
                    tools: [],
                })
            );

            const body = post$.mock.calls[0][1];
            expect(body.system).toBe('be brief\n\nanswer in English');
        });

        it('defaults the model to gemini-2.5-flash', async () => {
            const { post, post$ } = makeFakePost(textResponse('ok'));
            const gateway = createGateway({}, post);

            await drain(gateway.chat(userSays('hi')));

            expect(post$.mock.calls[0][1].model).toBe('gemini-2.5-flash');
        });

        it('honors a model override', async () => {
            const { post, post$ } = makeFakePost(textResponse('ok'));
            const gateway = createGateway({ model: 'gemini-2.5-pro' }, post);

            await drain(gateway.chat(userSays('hi')));

            expect(post$.mock.calls[0][1].model).toBe('gemini-2.5-pro');
        });

        it('maps temperature into config.temperature', async () => {
            const { post, post$ } = makeFakePost(textResponse('ok'));
            const gateway = createGateway({ generation: { temperature: 0.3 } }, post);

            await drain(gateway.chat(userSays('hi')));

            expect(post$.mock.calls[0][1].config).toEqual({ temperature: 0.3 });
        });
    });

    describe('transport', () => {
        it('posts to /runs/0/generate', async () => {
            const { post, post$ } = makeFakePost(textResponse('ok'));
            const gateway = createGateway({}, post);

            await drain(gateway.chat(userSays('hi')));

            expect(post$.mock.calls[0][0]).toBe('/runs/0/generate');
        });

        it('does not send connection or transport params', async () => {
            const { post, post$ } = makeFakePost(textResponse('ok'));
            const gateway = createGateway({}, post);

            await drain(gateway.chat(userSays('hi')));

            const config = post$.mock.calls[0][2];
            expect(config).not.toHaveProperty('params');
            expect(JSON.stringify(config)).not.toMatch(/connection|transport/);
        });

        it('passes the AbortSignal through to post', async () => {
            const { post, post$ } = makeFakePost(textResponse('ok'));
            const gateway = createGateway({}, post);
            const controller = new AbortController();

            await drain(gateway.chat(userSays('hi'), { signal: controller.signal }));

            expect(post$.mock.calls[0][2].signal).toBe(controller.signal);
        });

        it('throws AbortError if the signal is aborted by the time post resolves', async () => {
            const controller = new AbortController();
            const post: GenerateSyncPostFn = async () => {
                controller.abort();
                return { data: textResponse('ok') };
            };
            const gateway = createGateway({}, post);

            await expect(drain(gateway.chat(userSays('hi'), { signal: controller.signal }))).rejects.toThrow(/Aborted/);
        });
    });

    describe('response mapping', () => {
        it('maps a text response (output.content) to a text chunk then a done chunk with usage', async () => {
            const { post } = makeFakePost({
                output: { content: 'the answer' },
                usage: { promptToken: 12, completionToken: 34, totalToken: 46 },
            });
            const gateway = createGateway({}, post);

            const chunks = await drain(gateway.chat(userSays('hi')));

            expect(chunks).toEqual([
                { text: 'the answer' },
                { done: true, usage: { inputTokens: 12, outputTokens: 34 } },
            ]);
        });

        it('falls back to response.text when output.content is missing', async () => {
            const { post } = makeFakePost({ text: 'from text field' } as GenerateSyncResponse);
            const gateway = createGateway({}, post);

            const chunks = await drain(gateway.chat(userSays('hi')));

            expect(chunks[0]).toEqual({ text: 'from text field' });
        });

        it('falls back to inputTokenCount/outputTokenCount when usage.promptToken/completionToken are absent', async () => {
            const { post } = makeFakePost({
                output: { content: 'ok' },
                inputTokenCount: 21,
                outputTokenCount: 36,
            });
            const gateway = createGateway({}, post);

            const chunks = await drain(gateway.chat(userSays('hi')));

            expect(chunks[1]).toEqual({ done: true, usage: { inputTokens: 21, outputTokens: 36 } });
        });

        it('omits usage on the done chunk when neither usage nor token-count fields are present', async () => {
            const { post } = makeFakePost({ output: { content: 'ok' } });
            const gateway = createGateway({}, post);

            const chunks = await drain(gateway.chat(userSays('hi')));

            expect(chunks).toEqual([{ text: 'ok' }, { done: true }]);
        });

        it('throws a text-only error when output.content is an object (image result)', async () => {
            const { post } = makeFakePost({ output: { content: { data: 'data:image/png;base64,abc' } } });
            const gateway = createGateway({}, post);

            await expect(drain(gateway.chat(userSays('hi')))).rejects.toThrow(/text-only/);
        });

        it('throws a clear error when both output.content and text are missing', async () => {
            const { post } = makeFakePost({ output: {} } as unknown as GenerateSyncResponse);
            const gateway = createGateway({}, post);

            await expect(drain(gateway.chat(userSays('hi')))).rejects.toThrow(/missing output.content/);
        });
    });

    describe('tool rejection (text-only)', () => {
        it('rejects requests carrying tool definitions', async () => {
            const { post } = makeFakePost(textResponse('ok'));
            const gateway = createGateway({}, post);

            await expect(
                drain(
                    gateway.chat({
                        messages: [{ role: 'user', content: 'hi' }],
                        tools: [{ name: 'move_node', description: 'move', parameters: { type: 'object' } }],
                    })
                )
            ).rejects.toThrow(/text-only.*tool definitions/);
        });

        it('rejects requests carrying tool messages', async () => {
            const { post } = makeFakePost(textResponse('ok'));
            const gateway = createGateway({}, post);

            await expect(
                drain(
                    gateway.chat({
                        messages: [{ role: 'tool', content: '{}', toolCallId: 'c1' }],
                        tools: [],
                    })
                )
            ).rejects.toThrow(/text-only.*tool messages/);
        });

        it('rejects requests carrying assistant tool calls', async () => {
            const { post } = makeFakePost(textResponse('ok'));
            const gateway = createGateway({}, post);

            await expect(
                drain(
                    gateway.chat({
                        messages: [
                            {
                                role: 'assistant',
                                content: null,
                                toolCalls: [{ id: 'c1', name: 'move_node', args: '{}' }],
                            },
                        ],
                        tools: [],
                    })
                )
            ).rejects.toThrow(/text-only.*tool messages/);
        });
    });
});
