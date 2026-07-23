import { describe, expect, it } from 'vitest';

import { createCanvasToolProvider } from '../../canvas/canvasTools';
import { createInMemoryCanvasBinding } from '../../canvas/inMemoryCanvasBinding';
import { createVirtualAgentEnvironment } from '../../environment/createVirtualAgentEnvironment';
import { createFetchHttpRequest } from '../../http/FetchHttpRequest';
import { createOpenAiLlmGateway } from '../../llm/OpenAiLlmGateway';
import { createToolExecutor } from '../../tools/toolExecutor';

import type { AgentConfig } from '../../agent';
import type { Chunk } from '../../llm/llmGateway';
import type { NodeData } from '@lemoncloud/eureka-flows-api';

/**
 * Env-gated REAL-provider tool-call verification (Scope A: gateway + ToolExecutor, single turn).
 *
 * Skipped entirely unless `OPENAI_API_KEY` is set — CI and keyless runs never hit the network,
 * and no key is ever read into a browser bundle (this is a Node test env; the key is `process.env`
 * only, never a `VITE_` var) or logged. Do NOT claim provider tool calling works until this test
 * has actually run green against a live provider; the offline `OpenAiLlmGateway.spec.ts` proves
 * only our mapping/parsing, not the model's behavior.
 *
 * See docs/browser-agent/foundations/provider-tool-calling.md.
 */

const OPENAI_API_KEY = process.env['OPENAI_API_KEY'];
// Override the model for the real call if needed (default gpt-4o-mini — real, cheap, tool-capable).
const OPENAI_MODEL = process.env['OPENAI_TEST_MODEL'];

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

describe.runIf(!!OPENAI_API_KEY)('OpenAI real tool-call verification (env-gated)', () => {
    it('returns a structured move_node call that ToolExecutor executes: (100,200) -> (200,200)', async () => {
        const binding = createInMemoryCanvasBinding({
            nodes: [makeNode('text-1', 100, 200, { type: 'text-input' })],
            edges: [],
        });
        const provider = createCanvasToolProvider(binding);
        const executor = createToolExecutor();
        const config: AgentConfig = {
            id: 'locator-real',
            description: 'moves nodes on the canvas',
            systemPrompt: 'You move nodes on a visual canvas by calling the provided tools.',
            tools: [provider],
            grant: { canModifyCanvas: true },
        };

        const gateway = createOpenAiLlmGateway({
            environment: createVirtualAgentEnvironment(),
            http: createFetchHttpRequest(),
            apiKey: OPENAI_API_KEY as string,
            ...(OPENAI_MODEL ? { model: OPENAI_MODEL } : {}),
        });

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
    });
});
