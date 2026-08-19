export default function AppLoading() {
  return (
    <div className="chat-view">
      <div className="chat-messages" aria-busy="true" aria-label="Загрузка диалога">
        <div className="message-row">
          <div className="message-bubble message-bubble-assistant" style={{ width: "60%" }}>
            <div className="skeleton" style={{ height: "0.85rem", width: "90%", marginBottom: "0.4rem" }} />
            <div className="skeleton" style={{ height: "0.85rem", width: "70%" }} />
          </div>
        </div>
        <div className="message-row message-row-user">
          <div className="message-bubble message-bubble-user" style={{ width: "40%", background: "var(--surface-muted)" }}>
            <div className="skeleton" style={{ height: "0.85rem", width: "100%" }} />
          </div>
        </div>
      </div>
    </div>
  );
}
