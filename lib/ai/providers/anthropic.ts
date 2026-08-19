// lib/ai/providers/anthropic.ts
//
// Chat-only adapter: Anthropic has no embeddings API of its own, so
// AI_PROVIDER=anthropic always pairs this ChatProvider with Voyage's
// EmbeddingsProvider (providers/voyage.ts) -- wired together in
// lib/ai/index.ts, never inside this file.
//
// This uses `@ai-sdk/anthropic`, which implements the Anthropic Messages
// API streaming protocol itself (it does not wrap `@anthropic-ai/sdk`
// internally) -- so there's no separate raw Anthropic SDK dependency here,
// consistent with CLAUDE.md's "адаптеры оборачивают официальные
// провайдер-пакеты Vercel AI SDK, а не пишут стриминг с нуля".

import { createAnthropic } from "@ai-sdk/anthropic";
import { streamText } from "ai";
import type { ChatMessage, ChatProvider, ChatStreamResult } from "../types";
import { wrapAiSdkStream } from "../stream-utils";

export interface AnthropicConfig {
  apiKey: string;
  chatModel: string;
}

export class AnthropicChatProvider implements ChatProvider {
  readonly providerName = "anthropic";
  readonly modelName: string;
  private readonly aiSdk: ReturnType<typeof createAnthropic>;

  constructor(config: AnthropicConfig) {
    this.modelName = config.chatModel;
    this.aiSdk = createAnthropic({ apiKey: config.apiKey });
  }

  streamChat({
    systemPrompt,
    messages,
  }: {
    systemPrompt: string;
    messages: ChatMessage[];
  }): ChatStreamResult {
    const model = this.aiSdk.chat(this.modelName);
    return wrapAiSdkStream(
      () =>
        streamText({
          model,
          system: systemPrompt,
          messages,
          maxRetries: 0, // lib/ai/stream-utils.ts is the single retry layer -- see providers/openai.ts constructor comment for the same reasoning
        }),
      { provider: this.providerName }
    );
  }
}
