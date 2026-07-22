import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentHarnessPage } from './AgentHarnessPage';

const postMock = vi.fn();
// Stub web-core so createGenerateApiSyncLlmGateway's default post (api.post) never makes a
// real network call — this is a wiring test, not a real-backend smoke test. vi.mock is
// hoisted above the AgentHarnessPage import below.
vi.mock('@flows/web-core', () => ({
    api: { post: (...args: unknown[]) => postMock(...args) },
}));

// `send` is gated until the async storage read settles (hydration); flush that microtask
// after render so the first send isn't a no-op. Mirrors the pattern used in AgentPanel.spec.tsx.
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

afterEach(() => {
    cleanup();
    localStorage.clear();
    postMock.mockReset();
});

describe('AgentHarnessPage', () => {
    it('defaults to the fake gateway (toggle unchecked) and the scripted move scenario still works', async () => {
        render(<AgentHarnessPage />);
        await flushHydration();

        expect((screen.getByTestId('real-gateway-toggle') as HTMLInputElement).checked).toBe(false);

        typeAndSend('move the text input 10px right');

        await waitFor(() => {
            expect(screen.getByTestId('node-position').textContent).toMatch(/x=110, y=200/);
        });
        // The fake-gateway path never touches the network.
        expect(postMock).not.toHaveBeenCalled();
    });

    it('real sync gateway: completes with a plain-text response, no tool call, clean request shape', async () => {
        postMock.mockResolvedValue({
            data: {
                output: { content: 'I can only describe this — I have no way to move nodes myself.' },
                usage: { promptToken: 8, completionToken: 12 },
            },
        });

        render(<AgentHarnessPage />);
        await flushHydration();

        const toggle = screen.getByTestId('real-gateway-toggle') as HTMLInputElement;
        fireEvent.click(toggle);
        expect(toggle.checked).toBe(true);

        // Toggling swaps the gateway, which creates a fresh agent instance with its own
        // (async) hydration — flush it again before sending, or send is silently a no-op.
        await flushHydration();

        typeAndSend('Move the text input node 100px to the right.');

        await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));

        // Plain-text response reaches the panel — the real gateway completed the turn.
        await screen.findByText(/I can only describe this/);

        // No ToolExecutor dispatch happened: the node never moved off its initial position.
        expect(screen.getByTestId('node-position').textContent).toMatch(/x=100, y=200/);

        // No text-only tool-definition error surfaced anywhere in the panel.
        expect(screen.queryByText(/text-only/i)).toBeNull();

        // Trace shows the LLM call completed.
        await waitFor(() => {
            const traceText = screen.getByTestId('trace-events').textContent ?? '';
            expect(traceText).toMatch(/llm\.chat\.done/);
        });

        // Request shape: a plain text-only Generate body, no connection/transport params.
        const [url, body, config] = postMock.mock.calls[0];
        expect(url).toBe('/runs/0/generate');
        expect(body).not.toHaveProperty('tools');
        const bodyJson = JSON.stringify(body);
        expect(bodyJson).not.toMatch(/functionDeclarations/);
        expect(bodyJson).not.toMatch(/tool_calls/);
        expect(config).not.toHaveProperty('params');
        expect(JSON.stringify(config ?? {})).not.toMatch(/connection|transport/);
    });
});
