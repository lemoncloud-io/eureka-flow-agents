import { useMemo } from 'react';

import { createToolExecutor, toAgentGrant } from '@flows/agent';

import { AgentPanel } from './AgentPanel';
import { useAgentEnvironment } from '../hooks/useAgentEnvironment';
import { useLocatorAgent } from '../hooks/useLocatorAgent';
import {
    createCommandLlmGateway,
    createDesktopCanvasBinding,
    createGenerateApiLlmGateway,
    createGenerateApiSyncLlmGateway,
} from '../utils';
import { withExecutorTracing, withGatewayTracing } from '../utils/agentTracing';

import type { WorkflowCanvasRef } from './WorkflowCanvas';
import type { GenerateReceiver, GenerateResponse } from '../utils/createGenerateApiLlmGateway';
import type { FlowPermissions } from '@flows/flows';
import type { RefObject } from 'react';

interface FlowAgentPanelProps {
    /** The live canvas ref the desktop CanvasBinding is built over. */
    canvasRef: RefObject<WorkflowCanvasRef | null>;
    flowId: string;
    /** The live flow socket's connectionId — required by the `generate-ws` gateway. */
    connectionId?: string | null;
    /** Whether the flow socket is currently connected — required by the `generate-ws` gateway. */
    isSocketConnected?: boolean;
    /** Socket-layer receiver for `generate-ws` mode — see {@link useGenerateReceiver}. */
    generateReceiver?: GenerateReceiver<GenerateResponse> | null;
    /** The flow's live permissions; projected onto the agent grant so its tools match the role. */
    permissions: FlowPermissions;
}

// Opt-in real, credit-spending Generate path — same convention as VITE_PROCESS_API
// (libs/flows/src/api/process): unset or any other value keeps the default offline
// command gateway. Text-only (capabilities.toolCalls stays false, no tool calling) —
// see docs/browser-agent/foundations/real-llm-tool-verification.md.
const REAL_GATEWAY_ENV_VALUE = 'generate-sync';
// WebSocket/SLS variant — see docs/browser-agent/foundations/websocket-generate-verification.md.
// Unverified against a live backend (no frame has ever been observed); opt-in only.
const WS_GATEWAY_ENV_VALUE = 'generate-ws';
const REAL_GATEWAY_MODEL = 'gpt-5-mini';

const GENERATE_SYNC_SUBTITLE = 'Real Generate gateway enabled: replies are text-only and will not move nodes yet.';
const GENERATE_WS_SUBTITLE =
    'Real Generate gateway (WebSocket) enabled: replies stream over the flow socket and will not move nodes yet.';

/**
 * App-side container for the locator agent: builds the concrete ports, drives the agent via
 * {@link useLocatorAgent}, and hands `session` + `send` to the presentational {@link AgentPanel}.
 * All the agent wiring lives here, so FlowEditorPage only mounts `<FlowAgentPanel />`.
 */
export const FlowAgentPanel = ({
    canvasRef,
    flowId,
    connectionId = null,
    isSocketConnected = false,
    generateReceiver = null,
    permissions,
}: FlowAgentPanelProps) => {
    const binding = useMemo(() => createDesktopCanvasBinding(canvasRef), [canvasRef]);
    const { environment, traceReporter } = useAgentEnvironment();

    const gatewayFlag = import.meta.env.VITE_AGENT_GATEWAY;
    const useRealGenerateGateway = gatewayFlag === REAL_GATEWAY_ENV_VALUE;
    const useWsGenerateGateway = gatewayFlag === WS_GATEWAY_ENV_VALUE;

    // Offline command gateway by default (no network/key); the real Generate gateways are an
    // explicit, deploy-time opt-in — never a runtime toggle. Trace decorators emit
    // llm.chat.* / tool.* through the environment either way.
    const gateway = useMemo(() => {
        if (useWsGenerateGateway) {
            return withGatewayTracing(
                createGenerateApiLlmGateway({
                    getConnection: () => ({ isConnected: isSocketConnected, connectionId, generateReceiver }),
                    model: REAL_GATEWAY_MODEL,
                }),
                traceReporter
            );
        }
        return withGatewayTracing(
            useRealGenerateGateway
                ? createGenerateApiSyncLlmGateway({ model: REAL_GATEWAY_MODEL })
                : createCommandLlmGateway(),
            traceReporter
        );
    }, [
        traceReporter,
        useRealGenerateGateway,
        useWsGenerateGateway,
        isSocketConnected,
        connectionId,
        generateReceiver,
    ]);
    const executor = useMemo(() => withExecutorTracing(createToolExecutor(), traceReporter), [traceReporter]);
    // Match the agent's tool permissions to the flow's role (a viewer's move_node is denied at the executor).
    const grant = useMemo(() => toAgentGrant(permissions), [permissions]);

    const { session, send } = useLocatorAgent({ binding, flowId, gateway, environment, executor, grant });

    const subtitle = useWsGenerateGateway
        ? GENERATE_WS_SUBTITLE
        : useRealGenerateGateway
          ? GENERATE_SYNC_SUBTITLE
          : undefined;

    return <AgentPanel session={session} onSend={send} subtitle={subtitle} />;
};
