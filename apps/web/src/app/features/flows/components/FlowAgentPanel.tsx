import { useEffect, useMemo } from 'react';

import { createEngineCanvasBinding, toAgentGrant } from '@flows/agent';
import { useBlockRegistry } from '@flows/flows';
import { useWebSocketStore } from '@flows/socket';

import { AgentPanel } from './AgentPanel';
import { useAgent } from '../hooks/useAgent';
import { useAgentEnvironment } from '../hooks/useAgentEnvironment';
import { useToolSocketConnection } from '../hooks/useToolSocketConnection';
import {
    createBlockCatalogLookup,
    createEurekaToolCallLlmGateway,
    createFlowJSONTransportReceiver,
    createGenerateApiLlmGateway,
} from '../utils';
import { withGatewayTracing } from '../utils/agentTracing';

import type { GenerateReceiver, GenerateResponse, ToolSocketConnection } from '../utils';
import type { LlmGateway } from '@flows/agent';
import type { FlowEngine } from '@flows/engine';
import type { FlowPermissions } from '@flows/flows';

interface FlowAgentPanelProps {
    /** The engine that owns this screen's graph. Not a canvas ref, so any screen holding an engine can mount this. */
    engine: FlowEngine;
    flowId: string;
    /** The flow's live permissions; projected onto the user-permission ceiling the executor enforces. */
    permissions: FlowPermissions;
}

const EUREKA_AGENTS_API = 'EUREKA_AGENTS_API';
const gateWay: string = EUREKA_AGENTS_API;

/**
 * Selects the production gateway while retaining the pre-Eureka Agents API path as a fallback.
 */
const createProductionGateway = (
    connection: ToolSocketConnection,
    generateReceiver: GenerateReceiver<GenerateResponse>
): LlmGateway => {
    if (gateWay === EUREKA_AGENTS_API) {
        return createGenerateApiLlmGateway({
            toolCalls: true,
            getConnection: () => ({ ...connection.getSnapshot(), generateReceiver }),
        });
    }

    const endpointPath = import.meta.env['VITE_EUREKA_TOOL_CALL_ENDPOINT'] as string | undefined;
    if (!endpointPath) {
        return createGenerateApiLlmGateway({
            getConnection: () => {
                const { isConnected, id } = useWebSocketStore.getState();
                return { isConnected, connectionId: id, generateReceiver: null };
            },
        });
    }

    const provider = (import.meta.env['VITE_EUREKA_TOOL_CALL_PROVIDER'] as string | undefined) ?? 'openai';
    const requestedModel = (import.meta.env['VITE_EUREKA_TOOL_CALL_MODEL'] as string | undefined) ?? 'gpt-4o-mini';
    return createEurekaToolCallLlmGateway({ provider, requestedModel, endpointPath });
};

/**
 * App-side container for the **orchestrator** agent: builds the concrete ports, drives the agent via
 * {@link useAgent}, and hands `session` + `send` to the presentational {@link AgentPanel}. All the
 * agent wiring lives here, so FlowEditorPage only mounts `<FlowAgentPanel />`.
 *
 * The gateway is selected by {@link createProductionGateway}. Eureka Agents API uses the dedicated tool socket;
 * changing `gateWay` restores the pre-branch gateway selection path.
 */
export const FlowAgentPanel = ({ engine, flowId, permissions }: FlowAgentPanelProps) => {
    // Reads cannot lag a projection that pauses mid-drag; edits land in `transact`, so they
    // checkpoint for undo like a user drag.
    const binding = useMemo(() => createEngineCanvasBinding(engine), [engine]);
    const { environment, traceReporter } = useAgentEnvironment();
    const toolSocket = useToolSocketConnection(gateWay === EUREKA_AGENTS_API);
    const receiver = useMemo(() => createFlowJSONTransportReceiver(toolSocket), [toolSocket]);
    useEffect(() => receiver.attach(), [receiver]);
    const gateway = useMemo(
        () => withGatewayTracing(createProductionGateway(toolSocket, receiver.generateReceiver), traceReporter),
        [receiver, toolSocket, traceReporter]
    );
    // The user's flow-role permissions — the executor's ceiling on every specialist tool (a viewer's
    // move_node/rename is denied there, regardless of each agent's own fixed grant).
    const userPermissions = useMemo(() => toAgentGrant(permissions), [permissions]);
    // Block catalog behind the agent's node-read/config tools, from the live block registry.
    const blockRegistry = useBlockRegistry();
    const catalog = useMemo(() => createBlockCatalogLookup(blockRegistry), [blockRegistry]);

    const { session, send } = useAgent({ binding, flowId, gateway, environment, userPermissions, catalog });

    return <AgentPanel session={session} onSend={send} />;
};
