import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getPermissions, useCanvasStore } from '@flows/flows';

import { FlowAgentPanel } from './FlowAgentPanel';

import type { WorkflowCanvasRef } from './WorkflowCanvas';
import type { GenerateReceiver, GenerateResponse } from '../utils/createGenerateApiLlmGateway';
import type { NodeData } from '@lemoncloud/eureka-flows-api';
import type { RefObject } from 'react';

// Full-access permissions (canModifyCanvas/canEditConfig/canEditStructure/canRun all true) —
// these tests exercise the gateway/tool-call wiring, not permission gating, so grant everything
// an owner has to preserve pre-existing test behavior (moving nodes via command syntax).
const TEST_PERMISSIONS = getPermissions('owner');

const postMock = vi.fn();
// Stub web-core so createGenerateApiSyncLlmGateway's default post (api.post) never makes a
// real network call — this is a wiring test, not a real-backend smoke test. vi.mock is
// hoisted above the FlowAgentPanel import below.
vi.mock('@flows/web-core', () => ({
    api: { post: (...args: unknown[]) => postMock(...args) },
}));

/**
 * Minimal fake WorkflowCanvasRef — only what createDesktopCanvasBinding actually calls.
 * `createDesktopCanvasBinding.readGraph()` reads from `useCanvasStore`, not the ref (so a write
 * is visible to the next read within a turn), so the store must be seeded here too — otherwise
 * `list_nodes()`/`move_node()` see an empty graph regardless of what the ref reports.
 */
const makeCanvasRef = (nodes: NodeData[]): RefObject<WorkflowCanvasRef | null> => {
    let current = nodes.map(n => ({ ...n }));
    useCanvasStore.getState().setNodes(current);
    useCanvasStore.getState().setConnections([]);
    const ref = {
        current: {
            getWorkflow: () => ({ nodes: current, edges: [] }),
            updateNode: (id: string, updates: Partial<NodeData>) => {
                current = current.map(n => (n.id === id ? { ...n, ...updates } : n));
                useCanvasStore.getState().updateNodeData(id, updates);
            },
        } as unknown as WorkflowCanvasRef,
    };
    return ref as RefObject<WorkflowCanvasRef | null>;
};

const flushHydration = () =>
    act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });

const typeAndSend = (text: string) => {
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: text } });
    fireEvent.keyDown(box, { key: 'Enter' });
};

// Local dev machines may have VITE_AGENT_GATEWAY=generate-ws (or generate-sync) baked into
// .env.local for live manual testing — Vite loads .env.local regardless of mode, so it would
// otherwise leak into "flag unset" assertions here. Force a deterministic unset baseline;
// individual tests still override it with their own vi.stubEnv call.
beforeEach(() => {
    vi.stubEnv('VITE_AGENT_GATEWAY', '');
});

afterEach(() => {
    cleanup();
    localStorage.clear();
    postMock.mockReset();
    vi.unstubAllEnvs();
    useCanvasStore.getState().setNodes([]);
    useCanvasStore.getState().setConnections([]);
});

describe('FlowAgentPanel', () => {
    it('flag unset: defaults to the command gateway and can move a node with command syntax', async () => {
        const canvasRef = makeCanvasRef([
            { id: 'n1', type: 'http', customLabel: 'Fetch', position: { x: 200, y: 80 } },
        ]);

        render(<FlowAgentPanel canvasRef={canvasRef} flowId="f-default" permissions={TEST_PERMISSIONS} />);
        await flushHydration();

        typeAndSend('move(Fetch, up, 10)');

        await waitFor(() => {
            expect(canvasRef.current?.getWorkflow().nodes[0].position).toEqual({ x: 200, y: 70 });
        });
        expect(await screen.findByText(/Moved Fetch/)).toBeTruthy();
        expect(postMock).not.toHaveBeenCalled();
    });

    it('flag set to generate-sync: uses the real gateway, plain text, no tool call, clean request', async () => {
        vi.stubEnv('VITE_AGENT_GATEWAY', 'generate-sync');
        postMock.mockResolvedValue({
            data: {
                output: { content: 'I have no way to move nodes myself.' },
                usage: { promptToken: 8, completionToken: 12 },
            },
        });
        const canvasRef = makeCanvasRef([{ id: 'text-1', type: 'text-input', position: { x: 100, y: 200 } }]);

        render(<FlowAgentPanel canvasRef={canvasRef} flowId="f-real" permissions={TEST_PERMISSIONS} />);
        await flushHydration();

        typeAndSend('Move the text input node 100px to the right.');

        await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));

        await screen.findByText(/I have no way to move nodes myself/);

        // No ToolExecutor dispatch happened — the node never moved.
        expect(canvasRef.current?.getWorkflow().nodes[0].position).toEqual({ x: 100, y: 200 });

        // No text-only tool-definition error surfaced (distinct from the subtitle's own
        // "text-only" wording — this matches the actual gateway rejection message).
        expect(screen.queryByText(/tool (definitions|messages) are not supported/i)).toBeNull();

        const [url, body, config] = postMock.mock.calls[0];
        expect(url).toBe('/runs/0/generate');
        expect(body).toMatchObject({ model: 'gpt-5-mini' });
        expect(body).not.toHaveProperty('tools');
        const bodyJson = JSON.stringify(body);
        expect(bodyJson).not.toMatch(/functionDeclarations/);
        expect(bodyJson).not.toMatch(/tool_calls/);
        expect(config).not.toHaveProperty('params');
        expect(JSON.stringify(config ?? {})).not.toMatch(/connection|transport/);
    });

    it('unknown flag value: falls back to the command gateway', async () => {
        vi.stubEnv('VITE_AGENT_GATEWAY', 'nonsense');
        const canvasRef = makeCanvasRef([
            { id: 'n1', type: 'http', customLabel: 'Fetch', position: { x: 200, y: 80 } },
        ]);

        render(<FlowAgentPanel canvasRef={canvasRef} flowId="f-unknown" permissions={TEST_PERMISSIONS} />);
        await flushHydration();

        typeAndSend('move(Fetch, up, 10)');

        await waitFor(() => {
            expect(canvasRef.current?.getWorkflow().nodes[0].position).toEqual({ x: 200, y: 70 });
        });
        expect(postMock).not.toHaveBeenCalled();
    });

    it('subtitle reflects command vs generate-sync mode', async () => {
        const canvasRef = makeCanvasRef([]);

        const { unmount } = render(
            <FlowAgentPanel canvasRef={canvasRef} flowId="f-subtitle-default" permissions={TEST_PERMISSIONS} />
        );
        await flushHydration();
        expect(screen.getByText(/Move nodes with commands like move\(Fetch, up, 10\)\./)).toBeTruthy();
        await act(async () => unmount());

        vi.stubEnv('VITE_AGENT_GATEWAY', 'generate-sync');
        render(<FlowAgentPanel canvasRef={canvasRef} flowId="f-subtitle-real" permissions={TEST_PERMISSIONS} />);
        await flushHydration();
        expect(
            screen.getByText(/Real Generate gateway enabled: replies are text-only and will not move nodes yet\./)
        ).toBeTruthy();
    });

    it('flag set to generate-ws: posts with connection/transport params and resolves via the injected receiver', async () => {
        vi.stubEnv('VITE_AGENT_GATEWAY', 'generate-ws');
        postMock.mockResolvedValue(undefined); // real backend: the HTTP response is only an ACK

        const waits: string[] = [];
        const receiver: GenerateReceiver<GenerateResponse> = {
            wait: async (connectionId, fire) => {
                waits.push(connectionId);
                await fire();
                return { output: { content: 'Streamed over the socket.' } };
            },
        };

        const canvasRef = makeCanvasRef([{ id: 'text-1', type: 'text-input', position: { x: 100, y: 200 } }]);

        render(
            <FlowAgentPanel
                canvasRef={canvasRef}
                flowId="f-ws"
                connectionId="conn-123"
                isSocketConnected={true}
                generateReceiver={receiver}
                permissions={TEST_PERMISSIONS}
            />
        );
        await flushHydration();

        typeAndSend('Hello');

        await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
        expect(waits).toEqual(['conn-123']);

        await screen.findByText(/Streamed over the socket\./);

        const [url, , config] = postMock.mock.calls[0];
        expect(url).toBe('/runs/0/generate');
        expect(config).toMatchObject({ params: { connection: 'conn-123', transport: 1 } });
    });

    it('flag set to generate-ws but socket not connected: surfaces the gateway error instead of hanging', async () => {
        vi.stubEnv('VITE_AGENT_GATEWAY', 'generate-ws');
        const canvasRef = makeCanvasRef([]);

        render(
            <FlowAgentPanel
                canvasRef={canvasRef}
                flowId="f-ws-disconnected"
                connectionId={null}
                isSocketConnected={false}
                generateReceiver={null}
                permissions={TEST_PERMISSIONS}
            />
        );
        await flushHydration();

        typeAndSend('Hello');

        await screen.findByText(/flow socket is not connected/i);
        expect(postMock).not.toHaveBeenCalled();
    });
});
