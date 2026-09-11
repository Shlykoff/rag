// lib/ai/providers/anthropic.ts
//
// Chat-only adapter: Anthropic has no embeddings API, so a project chatting
// with Claude picks its embedding model separately (see lib/ai/index.ts).
//
// Uses `@ai-sdk/anthropic`, which implements the Messages API streaming
// protocol itself -- no separate `@anthropic-ai/sdk` dependency.

import { createAnthropic } from "@ai-sdk/anthropic";
import { streamText } from "ai";
import type { ChatMessage, ChatProvider, ChatStreamResult } from "../types";
import { fromStreamTextResult, logStreamError, wrapAiSdkStream } from "../stream-utils";

export interface AnthropicConfig {
  apiKey: string;
  model: string;
}

export class AnthropicChatProvider implements ChatProvider {
  readonly providerName = "anthropic";
  readonly modelName: string;
  private readonly aiSdk: ReturnType<typeof createAnthropic>;

  constructor(config: AnthropicConfig) {
    this.modelName = config.model;
    this.aiSdk = createAnthropic({ apiKey: config.apiKey });
  }

  streamChat({ systemPrompt, messages }: { systemPrompt: string; messages: ChatMessage[] }): ChatStreamResult {
    const model = this.aiSdk.chat(this.modelName);
    return wrapAiSdkStream(
      () =>
        fromStreamTextResult(
          streamText({
            model,
            system: systemPrompt,
            messages,
            maxRetries: 0, // lib/ai/stream-utils.ts is the only retry layer
            onError: logStreamError(this.providerName),
          })
        ),
      { provider: this.providerName }
    );
  }
}
