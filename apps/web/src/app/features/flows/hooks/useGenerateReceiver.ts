import { useRef } from 'react';

import { isGenerateFrameMessage } from '@flows/socket';

import type { GenerateReceiver, GenerateResponse } from '../utils/createGenerateApiLlmGateway';
import type { WebSocketMessage } from '@flows/socket';

interface PendingGenerate {
    resolve: (response: GenerateResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/** No frame observed within this window fails the turn with a visible, retryable error. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Socket-layer implementation of {@link GenerateReceiver}: resolves a Generate API result
 * delivered as a single `GenerateResponse`-shaped WebSocket frame, keyed by `connectionId`.
 *
 * Per the Generate API spec, the result arrives as one frame (no manifest/chunk/complete
 * streaming protocol — an earlier revision of this hook assumed streaming based on outdated
 * internal notes; that assumption didn't match the actual spec). The frame's exact wire
 * action/type name is still unconfirmed, so `handleMessage` is fed every parsed
 * `WebSocketMessage` and matches structurally via {@link isGenerateFrameMessage} rather than a
 * guessed action string.
 *
 * Usage: call `handleMessage` for every message from `useInitFlowSocket`'s `onMessage` (or
 * `dispatchMessage`) — registration happens synchronously inside `receiver.wait()`, so as long
 * as `handleMessage` is wired in before any `chat()` call fires, the result frame will find its
 * pending entry. Call `cancelAll` when the socket disconnects, so an in-flight wait fails
 * visibly instead of hanging forever (per spec: no automatic retry on disconnect).
 */
export const useGenerateReceiver = (timeoutMs: number = DEFAULT_TIMEOUT_MS) => {
    const pendingRef = useRef(new Map<string, PendingGenerate>());

    const settle = (connectionId: string): PendingGenerate | undefined => {
        const entry = pendingRef.current.get(connectionId);
        if (entry) {
            clearTimeout(entry.timer);
            pendingRef.current.delete(connectionId);
        }
        return entry;
    };

    const receiver: GenerateReceiver<GenerateResponse> = {
        wait: (connectionId, fire) =>
            new Promise<GenerateResponse>((resolve, reject) => {
                const timer = setTimeout(() => {
                    pendingRef.current.delete(connectionId);
                    reject(new Error(`Generate result timed out after ${timeoutMs}ms — no WebSocket frame arrived`));
                }, timeoutMs);
                pendingRef.current.set(connectionId, { resolve, reject, timer });
                fire().catch((error: unknown) => {
                    const entry = settle(connectionId);
                    entry?.reject(error instanceof Error ? error : new Error(String(error)));
                });
            }),
    };

    const handleMessage = (message: WebSocketMessage) => {
        if (!isGenerateFrameMessage(message)) return;

        const entry = settle(message.id);
        if (!entry) {
            console.warn('[GenerateReceiver] frame for unregistered connectionId, dropped', message);
            return;
        }

        const payload = (message.data ?? {}) as Record<string, unknown>;
        entry.resolve(payload as unknown as GenerateResponse);
    };

    /** Reject every in-flight wait — call when the socket disconnects mid-request. No retry is attempted here; the caller must resend. */
    const cancelAll = (reason: string) => {
        const entries = Array.from(pendingRef.current.values());
        pendingRef.current.clear();
        entries.forEach(entry => {
            clearTimeout(entry.timer);
            entry.reject(new Error(reason));
        });
    };

    return { receiver, handleMessage, cancelAll };
};
