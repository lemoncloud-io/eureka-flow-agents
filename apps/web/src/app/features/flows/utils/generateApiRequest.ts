import type { ChatRequest } from '@flows/agent';

/**
 * Request-side shapes and mapping shared by every eureka-flows-api Generate gateway
 * (`createGenerateApiSyncLlmGateway`, `createGenerateApiLlmGateway`). Both post the same
 * body to `/runs/0/generate` and differ only in transport (inline response vs.
 * WebSocket-delivered result) — see docs/browser-agent/foundations/llm-gateway.md §6/§7.
 */

export interface GenerateContent {
    role?: string;
    parts: Array<{
        text?: string;
        inlineData?: { data: string; mimeType?: string };
    }>;
}

export interface GenerateRequestBody {
    model: string;
    prompt: string | { type?: string; content: string | GenerateContent | GenerateContent[] };
    system?: string;
    image?: boolean;
    config?: {
        responseMimeType?: string;
        responseSchema?: unknown;
        responseModalities?: string[];
        temperature?: number;
        topP?: number;
        imageConfig?: { aspectRatio?: string; imageSize?: string };
    };
}

export const GENERATE_TEXT_ONLY = 'Generate API gateway is text-only in this slice (capabilities.toolCalls = false)';

/** Throws if the request carries tool definitions or any tool-call/tool-message content. */
export const assertGenerateTextOnlyRequest = (req: ChatRequest): void => {
    if (req.tools.length > 0) {
        throw new Error(`${GENERATE_TEXT_ONLY}: tool definitions are not supported`);
    }
    if (req.messages.some(message => message.role === 'tool' || (message.toolCalls?.length ?? 0) > 0)) {
        throw new Error(`${GENERATE_TEXT_ONLY}: tool messages are not supported`);
    }
};

export const toGenerateRequestBody = (
    req: ChatRequest,
    model: string,
    generation?: { temperature?: number }
): GenerateRequestBody => {
    const systemTexts = req.messages.filter(message => message.role === 'system').map(message => message.content ?? '');
    const turnMessages = req.messages.filter(message => message.role === 'user' || message.role === 'assistant');

    const prompt: GenerateRequestBody['prompt'] =
        turnMessages.length === 1 && turnMessages[0].role === 'user'
            ? (turnMessages[0].content ?? '')
            : {
                  content: turnMessages.map(
                      (message): GenerateContent => ({
                          role: message.role === 'assistant' ? 'model' : 'user',
                          parts: [{ text: message.content ?? '' }],
                      })
                  ),
              };

    return {
        model,
        prompt,
        ...(systemTexts.length > 0 ? { system: systemTexts.join('\n\n') } : {}),
        ...(generation?.temperature !== undefined ? { config: { temperature: generation.temperature } } : {}),
    };
};
