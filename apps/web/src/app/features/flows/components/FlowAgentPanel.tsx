import { useMemo } from 'react';

import { createToolExecutor } from '@flows/agent';

import { AgentPanel } from './AgentPanel';
import { useAgentEnvironment } from '../hooks/useAgentEnvironment';
import { useLocatorAgent } from '../hooks/useLocatorAgent';
import { createCommandLlmGateway, createDesktopCanvasBinding, createGenerateApiSyncLlmGateway } from '../utils';
import { withExecutorTracing, withGatewayTracing } from '../utils/agentTracing';

import type { WorkflowCanvasRef } from './WorkflowCanvas';
import type { RefObject } from 'react';

interface FlowAgentPanelProps {
    /** The live canvas ref the desktop CanvasBinding is built over. */
    canvasRef: RefObject<WorkflowCanvasRef | null>;
    flowId: string;
}

// Opt-in real, credit-spending Generate path — same convention as VITE_PROCESS_API
// (libs/flows/src/api/process): unset or any other value keeps the default offline
// command gateway. Text-only (capabilities.toolCalls stays false, no tool calling) —
// see docs/browser-agent/foundations/real-llm-tool-verification.md.
const REAL_GATEWAY_ENV_VALUE = 'generate-sync';
const REAL_GATEWAY_MODEL = 'gpt-5-mini';

const GENERATE_SYNC_SUBTITLE = 'Real Generate gateway enabled: replies are text-only and will not move nodes yet.';

/**
 * App-side container for the locator agent: builds the concrete ports, drives the agent via
 * {@link useLocatorAgent}, and hands `session` + `send` to the presentational {@link AgentPanel}.
 * All the agent wiring lives here, so FlowEditorPage only mounts `<FlowAgentPanel />`.
 */
export const FlowAgentPanel = ({ canvasRef, flowId }: FlowAgentPanelProps) => {
    const binding = useMemo(() => createDesktopCanvasBinding(canvasRef), [canvasRef]);
    const { environment, traceReporter } = useAgentEnvironment();

    const useRealGenerateGateway = import.meta.env.VITE_AGENT_GATEWAY === REAL_GATEWAY_ENV_VALUE;

    // Offline command gateway by default (no network/key); the real Generate gateway is an
    // explicit, deploy-time opt-in — never a runtime toggle. Trace decorators emit
    // llm.chat.* / tool.* through the environment either way.
    const gateway = useMemo(
        () =>
            withGatewayTracing(
                useRealGenerateGateway
                    ? createGenerateApiSyncLlmGateway({ model: REAL_GATEWAY_MODEL })
                    : createCommandLlmGateway(),
                traceReporter
            ),
        [traceReporter, useRealGenerateGateway]
    );
    const executor = useMemo(() => withExecutorTracing(createToolExecutor(), traceReporter), [traceReporter]);

    const { session, send } = useLocatorAgent({ binding, flowId, gateway, environment, executor });

    return (
        <AgentPanel
            session={session}
            onSend={send}
            subtitle={useRealGenerateGateway ? GENERATE_SYNC_SUBTITLE : undefined}
        />
    );
};
