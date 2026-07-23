// Shared, provider-neutral chat contract
export type {
    ChatMessage,
    ChatRequest,
    Chunk,
    JsonSchema,
    LlmGateway,
    LlmGatewayCapabilities,
    ToolDef,
} from './llmGateway';
export { createFakeGateway } from './fakeGateway';
export type { FakeGateway, FakeResponse, FakeScriptStep } from './fakeGateway';

// Gemini provider (HTTP, text-only)
export { createGeminiLlmGateway } from './GeminiLlmGateway';
export type { GeminiLlmGateway, GeminiLlmGatewayOptions } from './GeminiLlmGateway';

// OpenAI provider (HTTP, tool-capable; also serves OpenRouter via baseUrl override)
export { createOpenAiLlmGateway } from './OpenAiLlmGateway';
export type { OpenAiLlmGateway, OpenAiLlmGatewayOptions } from './OpenAiLlmGateway';
