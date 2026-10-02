export interface LlmPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

export interface LlmRequest {
  system: string;
  parts: LlmPart[];
  json?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  model?: string;
}

export interface LlmResult {
  text: string;
  model: string;
  promptTokens?: number;
  outputTokens?: number;
  finishReason?: string;
}

export interface LlmClient {
  generate(req: LlmRequest): Promise<LlmResult>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}
