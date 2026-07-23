import { describe, expect, it } from 'vitest';

import { createCanvasToolProvider } from '../../canvas/canvasTools';
import { createInMemoryCanvasBinding } from '../../canvas/inMemoryCanvasBinding';
import { createVirtualAgentEnvironment } from '../../environment/createVirtualAgentEnvironment';
import { createFetchHttpRequest } from '../../http/FetchHttpRequest';
import { createGeminiToolLlmGateway } from '../../llm/GeminiToolLlmGateway';
import { createOpenAiLlmGateway } from '../../llm/OpenAiLlmGateway';
import { createToolExecutor } from '../../tools/toolExecutor';

import type { AgentConfig } from '../../agent';
import type { Chunk, LlmGateway } from '../../llm/llmGateway';
import type { NodeData } from '@lemoncloud/eureka-flows-api';

/**
 * Env-gated REAL-provider tool-call verification (Scope A: gateway + ToolExecutor, single turn).
 *
 * Each provider block is skipped entirely unless its key env var is set — CI and keyless runs
 * never hit the network, and no key is ever read into a browser bundle (this is a Node test env;
 * keys are `process.env` only, never `VITE_` vars) or logged. Do NOT claim a provider's tool
 * calling works until its env-gated block has actually run green against the live API; the
 * offline `*.spec.ts` files prove only our mapping/parsing, not the models' behavior.
 *
 * See docs/browser-agent/foundations/provider-tool-calling.md.
 */

const OPENAI_API_KEY = process.env['OPENAI_API_KEY'];
const OPENAI_MODEL = process.env['OPENAI_TEST_MODEL']; // optional override; default gpt-4o-mini
const GEMINI_API_KEY = process.env['GEMINI_API_KEY'];
const GEMINI_MODEL = process.env['GEMINI_TEST_MODEL']; // optional override; default gemini-2.5-flash

const makeNode = (id: string, x: number, y: number, extra: Partial<NodeData> = {}): NodeData => ({
    id,
    type: 'test',
    position: { x, y },
    ...extra,
});

const drain = async (stream: AsyncIterable<Chunk>): Promise<Chunk[]> => {
    const chunks: Chunk[] = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return chunks;
};

/**
 * Shared Scope-A verification: seed a single text-input node, ask the real model (via the given
 * gateway) to move it 100px right, assert it emits a structured move_node call, dispatch that
 * through the real ToolExecutor, and assert the node moved (100,200) -> (200,200).
 */
const verifyMoveNodeToolCall = async (gateway: LlmGateway): Promise<void> => {
    const binding = createInMemoryCanvasBinding({
        nodes: [makeNode('text-1', 100, 200, { type: 'text-input' })],
        edges: [],
    });
    const executor = createToolExecutor();
    const config: AgentConfig = {
        id: 'locator-real',
        description: 'moves nodes on the canvas',
        systemPrompt: 'You move nodes on a visual canvas by calling the provided tools.',
        tools: [createCanvasToolProvider(binding)],
        grant: { canModifyCanvas: true },
    };

    // Seed the node list so the model can call move_node in one turn (Scope A — no multi-turn
    // tool-result round-trip). Mirrors LocatorAgent's per-turn node-context injection.
    const chunks = await drain(
        gateway.chat({
            messages: [
                { role: 'system', content: config.systemPrompt },
                {
                    role: 'system',
                    content: 'Current nodes on the canvas:\n- id="text-1" type="text-input" at (100, 200)',
                },
                { role: 'user', content: 'Move the text input node 100px to the right.' },
            ],
            tools: await executor.listTools(config),
        })
    );

    const toolCall = chunks.find(c => c.toolCall)?.toolCall;
    expect(toolCall, 'expected the model to emit a structured tool call').toBeTruthy();
    expect(toolCall!.name).toBe('move_node');

    const args = JSON.parse(toolCall!.argsDelta) as { nodeId?: string; by?: { dx?: number; dy?: number } };
    expect(args.nodeId).toBe('text-1');
    expect(args.by).toEqual({ dx: 100, dy: 0 });

    const result = await executor.dispatch(config, { id: toolCall!.id, name: toolCall!.name, args });
    expect(result.ok).toBe(true);
    expect(binding.readGraph().nodes[0].position).toEqual({ x: 200, y: 200 });
};

describe.runIf(!!OPENAI_API_KEY)('OpenAI real tool-call verification (env-gated)', () => {
    it('returns a structured move_node call that ToolExecutor executes: (100,200) -> (200,200)', async () => {
        await verifyMoveNodeToolCall(
            createOpenAiLlmGateway({
                environment: createVirtualAgentEnvironment(),
                http: createFetchHttpRequest(),
                apiKey: OPENAI_API_KEY as string,
                ...(OPENAI_MODEL ? { model: OPENAI_MODEL } : {}),
            })
        );
    });
});

describe.runIf(!!GEMINI_API_KEY)('Gemini real tool-call verification (env-gated)', () => {
    it('returns a structured move_node call that ToolExecutor executes: (100,200) -> (200,200)', async () => {
        await verifyMoveNodeToolCall(
            createGeminiToolLlmGateway({
                environment: createVirtualAgentEnvironment(),
                http: createFetchHttpRequest(),
                apiKey: GEMINI_API_KEY as string,
                ...(GEMINI_MODEL ? { model: GEMINI_MODEL } : {}),
            })
        );
    });
});
