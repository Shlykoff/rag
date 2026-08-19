import { SourceList } from "./SourceList";
import type { ChatMessageVM } from "./types";

export function MessageBubble({ message }: { message: ChatMessageVM }) {
  const isUser = message.role === "user";

  return (
    <div className={`message-row${isUser ? " message-row-user" : ""}`}>
      <div className={`message-bubble${isUser ? " message-bubble-user" : " message-bubble-assistant"}`}>
        {message.content ? (
          <p className="message-content">{message.content}</p>
        ) : message.pending ? (
          <p className="message-content message-typing" aria-live="polite">
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="visually-hidden">Ассистент печатает ответ</span>
          </p>
        ) : null}

        {message.error ? (
          <div className="alert alert-danger" style={{ marginTop: message.content ? "0.6rem" : 0 }} role="alert">
            {message.error.message}
            {message.error.retryable ? " Попробуйте повторить запрос." : ""}
          </div>
        ) : null}

        {!isUser && !message.pending && !message.error ? <SourceList sources={message.sources} /> : null}
      </div>
    </div>
  );
}
