import { useEffect, useMemo } from 'react';

import { createEngineCanvasBinding, toAgentGrant } from '@flows/agent';
import { useBlockRegistry } from '@flows/flows';

import { AgentPanel } from './AgentPanel';
import { useAgent } from '../hooks/useAgent';
import { useAgentEnvironment } from '../hooks/useAgentEnvironment';
import { useToolSocketConnection } from '../hooks/useToolSocketConnection';
import { createBlockCatalogLookup, createFlowJSONTransportReceiver, createGenerateApiLlmGateway } from '../utils';
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

/**
 * Builds the production, tool-capable, socket-delivered
 * {@link createGenerateApiLlmGateway} over `POST /runs/0/generate`.
 */
const createProductionGateway = (
    connection: ToolSocketConnection,
    generateReceiver: GenerateReceiver<GenerateResponse>
): LlmGateway =>
    createGenerateApiLlmGateway({
        toolCalls: true,
        getConnection: () => ({ ...connection.getSnapshot(), generateReceiver }),
    });

/**
 * App-side container for the **orchestrator** agent: builds the concrete ports, drives the agent via
 * {@link useAgent}, and hands `session` + `send` to the presentational {@link AgentPanel}. All the
 * agent wiring lives here, so FlowEditorPage only mounts `<FlowAgentPanel />`.
 *
 * The gateway is selected by {@link createProductionGateway} — the backend-proxied,
 * socket-delivered, tool-capable {@link createGenerateApiLlmGateway} by default (its result arrives over the
 * live flow socket when a connection ID exists, otherwise over HTTP).
 */
export const FlowAgentPanel = ({ engine, flowId, permissions }: FlowAgentPanelProps) => {
    // Reads cannot lag a projection that pauses mid-drag; edits land in `transact`, so they
    // checkpoint for undo like a user drag.
    const binding = useMemo(() => createEngineCanvasBinding(engine), [engine]);
    const { environment, traceReporter } = useAgentEnvironment();
    const toolSocket = useToolSocketConnection();
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
