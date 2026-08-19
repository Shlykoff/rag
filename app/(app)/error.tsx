"use client";

import { useEffect } from "react";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("app/(app) segment error:", error);
  }, [error]);

  return (
    <div style={{ padding: "2rem", maxWidth: "32rem", margin: "3rem auto" }}>
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <h2 style={{ fontSize: "1.1rem" }}>Что-то пошло не так</h2>
        <p className="field-hint">
          Не удалось загрузить эту страницу. Обычно это означает, что локальный Supabase не запущен
          (<code>supabase start</code>) или временно недоступен.
        </p>
        <div>
          <button type="button" className="btn btn-primary" onClick={() => reset()}>
            Попробовать снова
          </button>
        </div>
      </div>
    </div>
  );
}
