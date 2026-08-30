"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { parseSSEStream } from "./parse-sse";
import { MessageBubble } from "./MessageBubble";
import { NoProviderModal } from "./NoProviderModal";
import type { ChatMessageVM, ContextSource } from "./types";
// Type-only import: guarantees this component's SSE handling stays in
// sync with the exact event shapes app/api/chat/route.ts streams (see
// that route's module comment for the wire contract). No runtime code
// from lib/chat/ is imported/bundled here.
import type { ChatStreamEvent } from "@/lib/chat/handle-chat-request";
import { redirectToLogin } from "@/lib/ui/client-redirect";

export interface ChatViewProps {
  /** The project this chat is scoped to -- threaded into every /api/chat call and every onward "add a provider"/"add a document" link. */
  projectId: string;
  conversationId?: string;
  initialMessages: ChatMessageVM[];
  hasDocuments: boolean;
}

interface RateLimitNotice {
  message: string;
  retryAfterMs: number;
}

function makeId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function ChatView({ projectId, conversationId: initialConversationId, initialMessages, hasDocuments }: ChatViewProps) {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessageVM[]>(initialMessages);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [rateLimitNotice, setRateLimitNotice] = useState<RateLimitNotice | null>(null);
  const [showNoProviderModal, setShowNoProviderModal] = useState(false);

  const conversationIdRef = useRef<string | undefined>(initialConversationId);
  const isNewChatRef = useRef<boolean>(initialConversationId === undefined);
  const abortRef = useRef<AbortController | null>(null);
  const listEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  function updateAssistantMessage(id: string, patch: Partial<ChatMessageVM>) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;

    setRateLimitNotice(null);

    const userMessage: ChatMessageVM = { id: makeId(), role: "user", content: trimmed, sources: [] };
    const assistantMessageId = makeId();
    const assistantMessage: ChatMessageVM = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      sources: [],
      pending: true,
      question: trimmed,
    };
    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInput("");
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    let receivedConversationId: string | null = null;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, conversationId: conversationIdRef.current, message: trimmed }),
        signal: controller.signal,
      });

      if (response.status === 401) {
        redirectToLogin();
        return;
      }

      if (response.status === 429) {
        const body = (await response.json().catch(() => ({}))) as { message?: string; retryAfterMs?: number };
        setRateLimitNotice({
          message: body.message ?? "Слишком много запросов. Попробуйте чуть позже.",
          retryAfterMs: body.retryAfterMs ?? 10000,
        });
        updateAssistantMessage(assistantMessageId, {
          pending: false,
          error: { message: body.message ?? "Слишком много запросов. Попробуйте чуть позже.", retryable: true },
        });
        return;
      }

      // Specific to app/api/chat/route.ts's `422 { error: "no_credentials" }`
      // -- the signed-in user has no active AI provider configured yet.
      // Distinct from every other error status (400/429/500), which keep
      // the generic retry-banner treatment below: retrying a "no
      // credentials" turn can never succeed until the user actually visits
      // /profile, so this shows a dedicated modal instead of a "Повторить"
      // button that would just fail again.
      if (response.status === 422) {
        const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
        if (body.error === "no_credentials") {
          setShowNoProviderModal(true);
          updateAssistantMessage(assistantMessageId, {
            pending: false,
            error: {
              message: body.message ?? "Добавьте AI-провайдера в профиле, чтобы получить ответ.",
              retryable: false,
            },
          });
          return;
        }
        // Any other (unexpected, per the documented contract) 422 shape
        // falls back to the same generic handling as 400/500 below.
        updateAssistantMessage(assistantMessageId, {
          pending: false,
          error: { message: describeGenericError(422, body.error), retryable: false },
        });
        return;
      }

      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => ({}))) as { error?: string; details?: unknown };
        updateAssistantMessage(assistantMessageId, {
          pending: false,
          error: {
            message: describeGenericError(response.status, body.error),
            retryable: response.status >= 500,
          },
        });
        return;
      }

      for await (const raw of parseSSEStream(response.body)) {
        const event = raw.data as ChatStreamEvent;
        switch (event.type) {
          case "conversation": {
            receivedConversationId = event.conversationId;
            conversationIdRef.current = event.conversationId;
            break;
          }
          case "sources": {
            updateAssistantMessage(assistantMessageId, { sources: event.sources as ContextSource[] });
            break;
          }
          case "delta": {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMessageId ? { ...m, content: m.content + event.text, pending: false } : m
              )
            );
            break;
          }
          case "done": {
            updateAssistantMessage(assistantMessageId, { pending: false });
            break;
          }
          case "error": {
            updateAssistantMessage(assistantMessageId, {
              pending: false,
              error: { message: event.message, retryable: event.retryable },
            });
            break;
          }
        }
      }
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      updateAssistantMessage(assistantMessageId, {
        pending: false,
        error: { message: "Не удалось подключиться к серверу. Проверьте соединение и повторите.", retryable: true },
      });
    } finally {
      setIsStreaming(false);
      // New-chat -> now-persisted-conversation navigation: only once, only
      // when this view started with no conversationId
      // (projects/[projectId]/chat/(list)/page.tsx) and the server actually
      // created/confirmed one via the `conversation` SSE event (see
      // handleChatRequest -- it's always yielded first, before any possible
      // error).
      if (isNewChatRef.current && receivedConversationId) {
        isNewChatRef.current = false;
        router.replace(`/projects/${projectId}/chat/${receivedConversationId}`);
        router.refresh();
      }
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage(input);
  }

  function handleRetry(content: string) {
    void sendMessage(content);
  }

  return (
    <div className="chat-view">
      <div className="chat-messages">
        {messages.length === 0 ? (
          <div className="chat-empty-state">
            <h2>Задайте вопрос по вашим документам</h2>
            {hasDocuments ? (
              <p>Ассистент отвечает только на основе того, что реально загружено, и указывает источники под ответом.</p>
            ) : (
              <>
                <p>В этом проекте пока нет ни одного документа — ассистент не сможет найти в чём искать ответ.</p>
                <a href={`/projects/${projectId}/documents`} className="btn btn-primary">
                  Добавить первый документ
                </a>
              </>
            )}
          </div>
        ) : (
          messages.map((message) => (
            <MessageContainer key={message.id} message={message} onRetry={handleRetry} />
          ))
        )}
        <div ref={listEndRef} />
      </div>

      {rateLimitNotice ? (
        <div className="alert alert-warning chat-banner" role="alert">
          {rateLimitNotice.message} (примерно {Math.ceil(rateLimitNotice.retryAfterMs / 1000)} сек.)
        </div>
      ) : null}

      <form className="chat-input-bar" onSubmit={handleSubmit}>
        <label htmlFor="chat-message-input" className="visually-hidden">
          Сообщение ассистенту
        </label>
        <textarea
          id="chat-message-input"
          className="textarea chat-input"
          placeholder="Спросите что-нибудь о ваших документах…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void sendMessage(input);
            }
          }}
          disabled={isStreaming}
          rows={2}
        />
        <button type="submit" className="btn btn-primary" disabled={isStreaming || input.trim().length === 0}>
          {isStreaming ? "Отвечаю…" : "Отправить"}
        </button>
      </form>

      {showNoProviderModal ? (
        <NoProviderModal projectId={projectId} onDismiss={() => setShowNoProviderModal(false)} />
      ) : null}
    </div>
  );
}

function MessageContainer({
  message,
  onRetry,
}: {
  message: ChatMessageVM;
  onRetry: (content: string) => void;
}) {
  return (
    <div>
      <MessageBubble message={message} />
      {message.role === "assistant" && message.error?.retryable && message.question ? (
        <div className="message-retry-row">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onRetry(message.question!)}>
            Повторить
          </button>
        </div>
      ) : null}
    </div>
  );
}

function describeGenericError(status: number, errorCode?: string): string {
  if (status === 400) return "Некорректный запрос. Попробуйте переформулировать сообщение.";
  if (status >= 500) return "Сервис временно недоступен. Попробуйте позже.";
  return `Не удалось получить ответ (${errorCode ?? status}).`;
}
