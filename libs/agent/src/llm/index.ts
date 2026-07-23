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

// Gemini provider (HTTP, tool-capable — separate from the text-only gateway above)
export { createGeminiToolLlmGateway } from './GeminiToolLlmGateway';
export type { GeminiToolLlmGateway, GeminiToolLlmGatewayOptions } from './GeminiToolLlmGateway';

// OpenAI provider (HTTP, tool-capable; also serves OpenRouter via baseUrl override)
export { createOpenAiLlmGateway } from './OpenAiLlmGateway';
export type { OpenAiLlmGateway, OpenAiLlmGatewayOptions } from './OpenAiLlmGateway';
