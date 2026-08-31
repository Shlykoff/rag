"use client";

// components/projects/TelegramChannelPanel.tsx
//
// Connect/status/disconnect for a project's Telegram integration, via
// GET/POST/DELETE /api/projects/{projectId}/channels/telegram (see that
// route's own header for the exact contract). Short, concrete setup
// instructions are inline in the form itself (per CLAUDE.md's requirement
// that source/channel connection instructions live in the form, not only
// in the README), and `telegram_setup_failed` (almost always an invalid
// bot token) is surfaced as the server's own clear message, never a raw
// error dump.
//
// WEBHOOK STATUS (qa-reviewer follow-up fix on the API side): a saved
// `channel_integrations` row alone doesn't mean the bot is actually live --
// the row is written BEFORE Telegram's own setWebhook call is even
// attempted, and a previously-working webhook can later go stale outside
// this app entirely (token revoked, webhook cleared via BotFather, ...).
// GET now calls Telegram's own getWebhookInfo live on every request and
// reports `webhookStatus: "confirmed" | "unconfirmed"` alongside
// `connected: true` -- three states to render, not two:
//   1. Not connected (`connected: false`) -- show the connect form.
//   2. Connected but unconfirmed (`webhookStatus: "unconfirmed"`) -- a
//      credential is saved, but Telegram does NOT currently have this
//      integration's webhook URL registered, so the bot may not actually
//      be answering anyone right now. Deliberately NOT styled as an error
//      (nothing failed just now, from this page's point of view) and NOT
//      styled as the "bot is live" success state either -- a distinct
//      warning treatment, since the two mean very different things to a
//      project owner wondering why their bot has gone quiet.
//   3. Connected and confirmed (`webhookStatus: "confirmed"`) -- the real
//      "bot is live and answering" state; only this one gets the
//      established "Подключён. Webhook активен..." success copy.
// This is live-computed, not a cached DB flag, so it self-corrects on the
// next page load/refresh if the webhook is later revoked or restored
// outside the app -- nothing here needs to poll or invalidate anything.
//
// GET/POST/DELETE fetch + status-code branching goes through
// components/sources/request-helpers.ts's getJson()/postJson()/del()
// (shared with ModelPicker.tsx/ProfileForm.tsx) rather than hand-rolling
// its own 401/429/!ok handling per call site; the rate-limit "(~N сек.)"
// suffix uses that module's retryAfterSuffix() rather than reimplementing
// the same `Math.ceil(retryAfterMs / 1000)` formatting inline.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { redirectToLogin } from "@/lib/ui/client-redirect";
import { resolveTelegramWebhookStatus } from "@/lib/ui/format";
import { del, getJson, postJson, retryAfterSuffix } from "@/components/sources/request-helpers";

type WebhookStatus = "confirmed" | "unconfirmed";

interface StatusResponse {
  connected: boolean;
  enabled?: boolean;
  displayLabel?: string | null;
  webhookStatus?: WebhookStatus;
}

interface ConnectResponse {
  integrationId: string;
  displayLabel: string | null;
  enabled: boolean;
  webhookUrl: string;
  webhookStatus: "confirmed";
  status: "connected";
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; connected: false }
  | { status: "ready"; connected: true; enabled: boolean; displayLabel: string | null; webhookStatus: WebhookStatus };

async function fetchStatus(projectId: string): Promise<LoadState> {
  const result = await getJson<StatusResponse>(`/api/projects/${projectId}/channels/telegram`);
  if (!result.ok) {
    if (result.kind === "unauthorized") {
      redirectToLogin();
      return { status: "loading" };
    }
    return { status: "error", message: result.message };
  }
  const data = result.data;
  if (!data.connected) return { status: "ready", connected: false };
  return {
    status: "ready",
    connected: true,
    enabled: data.enabled ?? true,
    displayLabel: data.displayLabel ?? null,
    webhookStatus: resolveTelegramWebhookStatus(data.webhookStatus),
  };
}

const DISCONNECT_CONFIRM_TIMEOUT_MS = 5000;

export function TelegramChannelPanel({ projectId }: { projectId: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [showConnectForm, setShowConnectForm] = useState(false);

  const [botToken, setBotToken] = useState("");
  // Lazy initializer (not a useEffect + setState) so this never triggers a
  // second, cascading render -- react-hooks/set-state-in-effect flags
  // exactly that pattern (see Sidebar.tsx's/ProfileForm.tsx's own comments
  // elsewhere in this codebase for the same rule applied to other effects).
  // `window` is always defined by the time this client component mounts;
  // the guard is only for the (never actually hit) SSR render pass.
  const [webhookBaseUrl, setWebhookBaseUrl] = useState(() => (typeof window !== "undefined" ? window.location.origin : ""));
  const [displayLabel, setDisplayLabel] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectSuccess, setConnectSuccess] = useState<string | null>(null);

  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const confirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchStatus(projectId).then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    return () => {
      if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
    };
  }, []);

  function handleRetry() {
    setState({ status: "loading" });
    void fetchStatus(projectId).then((result) => setState(result));
  }

  async function handleConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setConnectError(null);
    setConnectSuccess(null);

    const trimmedToken = botToken.trim();
    const trimmedUrl = webhookBaseUrl.trim();
    if (!trimmedToken) {
      setConnectError("Вставьте токен бота, выданный @BotFather.");
      return;
    }
    if (!trimmedUrl.startsWith("https://")) {
      setConnectError("Адрес должен начинаться с https:// — Telegram требует HTTPS для webhook.");
      return;
    }

    setConnecting(true);
    const result = await postJson<ConnectResponse>(`/api/projects/${projectId}/channels/telegram`, {
      botToken: trimmedToken,
      webhookBaseUrl: trimmedUrl,
      displayLabel: displayLabel.trim() || undefined,
    });
    setConnecting(false);
    if (!result.ok) {
      if (result.kind === "unauthorized") {
        redirectToLogin();
        return;
      }
      if (result.kind === "rate_limited") {
        setConnectError(`${result.message}${retryAfterSuffix(result.retryAfterMs)}`);
        return;
      }
      // Covers `telegram_setup_failed` (the single most common cause: an
      // invalid/revoked bot token) the same way every other failure is
      // handled -- normalizeResponse's describeErrorBody() already prefers
      // the server's own actionable `message` when present (see this
      // file's own header comment: never a raw error dump), so no separate
      // branch on `result.code` is needed here.
      setConnectError(result.message);
      return;
    }
    const data = result.data;
    setState({
      status: "ready",
      connected: true,
      enabled: data.enabled,
      displayLabel: data.displayLabel,
      webhookStatus: data.webhookStatus,
    });
    setConnectSuccess(`Бот подключён. Webhook зарегистрирован: ${data.webhookUrl}`);
    setBotToken("");
    setShowConnectForm(false);
  }

  function handleDisconnectClick() {
    setDisconnectError(null);
    setConfirmingDisconnect(true);
    if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
    confirmTimeoutRef.current = setTimeout(() => setConfirmingDisconnect(false), DISCONNECT_CONFIRM_TIMEOUT_MS);
  }

  async function handleConfirmDisconnect() {
    if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
    setDisconnecting(true);
    setDisconnectError(null);
    const result = await del<{ status: string }>(`/api/projects/${projectId}/channels/telegram`);
    setDisconnecting(false);
    if (!result.ok) {
      if (result.kind === "unauthorized") {
        redirectToLogin();
        return;
      }
      setDisconnectError(result.message);
      return;
    }
    setState({ status: "ready", connected: false });
    setConfirmingDisconnect(false);
    setConnectSuccess(null);
  }

  if (state.status === "loading") {
    return (
      <div className="card" style={{ height: "8rem" }} aria-busy="true" aria-label="Загрузка статуса Telegram">
        <div className="skeleton" style={{ height: "100%", width: "100%" }} />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="card empty-state" role="alert">
        <p>{state.message}</p>
        <div>
          <button type="button" className="btn btn-secondary" onClick={handleRetry}>
            Попробовать снова
          </button>
        </div>
      </div>
    );
  }

  const showForm = !state.connected || showConnectForm;

  return (
    <section className="card" aria-labelledby="telegram-heading" style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }}>
      <h2 id="telegram-heading" style={{ fontSize: "1.05rem" }}>
        Telegram-бот
      </h2>

      {state.connected && state.webhookStatus === "confirmed" ? (
        <div className="alert alert-info" role="status" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.6rem", flexWrap: "wrap" }}>
          <span>
            Подключён{state.displayLabel ? `: ${state.displayLabel}` : ""}. Webhook активен — бот отвечает
            пользователям на основе документов и модели этого проекта.
          </span>
        </div>
      ) : null}

      {state.connected && state.webhookStatus === "unconfirmed" ? (
        <div className="alert alert-warning" role="status">
          <p style={{ margin: 0 }}>
            Сохранено{state.displayLabel ? `: ${state.displayLabel}` : ""}, но webhook не подтверждён — бот может не
            отвечать. Возможно, токен был отозван, webhook был сброшен вручную через BotFather, либо
            предыдущая настройка не завершилась успешно. Проверьте токен и переподключите бота ниже.
          </p>
        </div>
      ) : null}

      {connectSuccess ? (
        <div className="alert alert-info" role="status">
          {connectSuccess}
        </div>
      ) : null}

      {showForm ? (
        <form onSubmit={handleConnect} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <ol className="source-instructions">
            <li>
              В Telegram напишите{" "}
              <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">
                @BotFather
              </a>{" "}
              → <code>/newbot</code> (или используйте существующего бота) и скопируйте выданный токен.
            </li>
            <li>Рекомендуется отключить у бота приём в группы (BotFather → /setjoingroups → Disable).</li>
            <li>Вставьте токен ниже.</li>
            <li>
              Укажите публичный HTTPS-адрес этого приложения (в проде — его домен; локально — адрес
              туннеля ngrok/cloudflared, так как Telegram не может достучаться до localhost).
            </li>
          </ol>
          <div className="field">
            <label htmlFor="telegram-bot-token">Токен бота</label>
            <input
              id="telegram-bot-token"
              type="password"
              className="input"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="123456:ABC-DEF..."
              autoComplete="off"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="telegram-webhook-base-url">Публичный адрес приложения (https://)</label>
            <input
              id="telegram-webhook-base-url"
              type="url"
              className="input"
              value={webhookBaseUrl}
              onChange={(e) => setWebhookBaseUrl(e.target.value)}
              placeholder="https://example.com"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="telegram-display-label">Название (необязательно)</label>
            <input
              id="telegram-display-label"
              type="text"
              className="input"
              value={displayLabel}
              onChange={(e) => setDisplayLabel(e.target.value)}
              placeholder="например, @my_support_bot"
            />
          </div>
          {connectError ? (
            <div className="alert alert-danger" role="alert">
              {connectError}
            </div>
          ) : null}
          <div style={{ display: "flex", gap: "0.6rem" }}>
            <button type="submit" className="btn btn-primary" disabled={connecting}>
              {connecting ? "Подключаем…" : state.connected ? "Заменить токен" : "Подключить бота"}
            </button>
            {state.connected ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowConnectForm(false)} disabled={connecting}>
                Отмена
              </button>
            ) : null}
          </div>
        </form>
      ) : (
        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowConnectForm(true)}>
            Заменить токен
          </button>
          {confirmingDisconnect ? (
            <span style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
              <span className="field-hint">Точно отключить бота?</span>
              <button type="button" className="btn btn-danger btn-sm" onClick={handleConfirmDisconnect} disabled={disconnecting}>
                {disconnecting ? "Отключаем…" : "Да, отключить"}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setConfirmingDisconnect(false)}
                disabled={disconnecting}
              >
                Отмена
              </button>
            </span>
          ) : (
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleDisconnectClick}>
              Отключить бота
            </button>
          )}
        </div>
      )}
      {disconnectError ? (
        <div className="alert alert-danger" role="alert">
          {disconnectError}
        </div>
      ) : null}
    </section>
  );
}
