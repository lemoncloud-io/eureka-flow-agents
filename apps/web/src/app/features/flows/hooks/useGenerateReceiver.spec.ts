import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseWebSocketMessage } from '@flows/socket';

import { useGenerateReceiver } from './useGenerateReceiver';

import type { WebSocketMessage } from '@flows/socket';

/** Simulates a raw single-frame Generate result arriving over the worker's `onmessage`. */
const rawResultFrame = (
    connectionId: string,
    output: Record<string, unknown> = { content: 'hi' }
): WebSocketMessage => {
    const parsed = parseWebSocketMessage({ connectionId, output });
    if (!parsed) throw new Error(`test setup: parseWebSocketMessage dropped connectionId=${connectionId}`);
    return parsed;
};

describe('useGenerateReceiver', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('registers interest before firing, then resolves on the single result frame', async () => {
        const { result } = renderHook(() => useGenerateReceiver());
        const fire = vi.fn().mockResolvedValue(undefined);

        const resultPromise = result.current.receiver.wait('conn-1', fire);

        // fire() (the HTTP POST) must have already run by the time we can feed a frame back in —
        // registration happened synchronously inside wait(), before fire() was even awaited.
        expect(fire).toHaveBeenCalledTimes(1);

        result.current.handleMessage(rawResultFrame('conn-1', { content: 'Hello, world.' }));

        await expect(resultPromise).resolves.toEqual({ connectionId: 'conn-1', output: { content: 'Hello, world.' } });
    });

    it('rejects and cleans up if fire() (the HTTP POST) itself throws', async () => {
        const { result } = renderHook(() => useGenerateReceiver());
        const postError = new Error('network down');

        const resultPromise = result.current.receiver.wait('conn-3', () => Promise.reject(postError));

        await expect(resultPromise).rejects.toThrow('network down');

        // A late frame for the now-cleaned-up connection is dropped, not thrown.
        expect(() => result.current.handleMessage(rawResultFrame('conn-3'))).not.toThrow();
    });

    it('drops frames for a connectionId with no pending wait()', () => {
        const { result } = renderHook(() => useGenerateReceiver());
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        expect(() => result.current.handleMessage(rawResultFrame('unregistered-conn'))).not.toThrow();
        expect(warn).toHaveBeenCalled();

        warn.mockRestore();
    });

    it('ignores non-generate frames entirely (e.g. a node/trace message)', async () => {
        const { result } = renderHook(() => useGenerateReceiver());
        const resultPromise = result.current.receiver.wait('conn-4', () => Promise.resolve());

        result.current.handleMessage({ id: 'node-1', data: { type: 'node', id: 'node-1' } });
        result.current.handleMessage(rawResultFrame('conn-4', { content: 'done' }));

        await expect(resultPromise).resolves.toEqual({ connectionId: 'conn-4', output: { content: 'done' } });
    });

    it('rejects with a clear timeout error if no frame arrives in time, and cleans up pending state', async () => {
        vi.useFakeTimers();
        const { result } = renderHook(() => useGenerateReceiver(1000));

        const resultPromise = result.current.receiver.wait('conn-5', () => Promise.resolve());
        const assertion = expect(resultPromise).rejects.toThrow(/timed out/i);

        await vi.advanceTimersByTimeAsync(1000);
        await assertion;

        // A frame that arrives after the timeout has already cleaned up is dropped, not applied.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        expect(() => result.current.handleMessage(rawResultFrame('conn-5'))).not.toThrow();
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('does not fire the timeout once the frame already resolved the wait', async () => {
        vi.useFakeTimers();
        const { result } = renderHook(() => useGenerateReceiver(1000));

        const resultPromise = result.current.receiver.wait('conn-6', () => Promise.resolve());
        result.current.handleMessage(rawResultFrame('conn-6', { content: 'fast' }));

        await vi.advanceTimersByTimeAsync(1000);
        await expect(resultPromise).resolves.toEqual({ connectionId: 'conn-6', output: { content: 'fast' } });
    });

    it('cancelAll rejects every in-flight wait with the given reason and does not retry', async () => {
        const { result } = renderHook(() => useGenerateReceiver());

        const first = result.current.receiver.wait('conn-a', () => Promise.resolve());
        const second = result.current.receiver.wait('conn-b', () => Promise.resolve());

        result.current.cancelAll('WebSocket connection lost — Generate result cannot be delivered');

        await expect(first).rejects.toThrow(/connection lost/i);
        await expect(second).rejects.toThrow(/connection lost/i);

        // Cancelled connections are also unregistered — a stray late frame is dropped, not applied.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        expect(() => result.current.handleMessage(rawResultFrame('conn-a'))).not.toThrow();
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});
