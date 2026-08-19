"use client";

import { useState } from "react";
import { UploadForm } from "./UploadForm";
import { NotionForm } from "./NotionForm";
import { UrlForm } from "./UrlForm";
import { GoogleDriveForm } from "./GoogleDriveForm";

type SourceTab = "upload" | "notion" | "url" | "google_drive";

const TABS: { id: SourceTab; label: string }[] = [
  { id: "upload", label: "Загрузка файла" },
  { id: "notion", label: "Notion" },
  { id: "url", label: "Публичный URL" },
  { id: "google_drive", label: "Google Drive" },
];

export interface AddSourceFormProps {
  hasNotionCredential: boolean;
  hasGoogleDriveCredential: boolean;
}

export function AddSourceForm({ hasNotionCredential, hasGoogleDriveCredential }: AddSourceFormProps) {
  const [activeTab, setActiveTab] = useState<SourceTab>("upload");

  return (
    <section className="card" aria-labelledby="add-source-heading">
      <h2 id="add-source-heading" style={{ fontSize: "1.05rem", marginBottom: "0.9rem" }}>
        Добавить источник
      </h2>

      <div className="source-tabs" role="tablist" aria-label="Выбор источника документа">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`panel-${tab.id}`}
            className={`source-tab${activeTab === tab.id ? " source-tab-active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`panel-${activeTab}`}
        aria-labelledby={`tab-${activeTab}`}
        className="source-tab-panel"
      >
        {activeTab === "upload" ? <UploadForm /> : null}
        {activeTab === "notion" ? <NotionForm initialConnected={hasNotionCredential} /> : null}
        {activeTab === "url" ? <UrlForm /> : null}
        {activeTab === "google_drive" ? <GoogleDriveForm initialConnected={hasGoogleDriveCredential} /> : null}
      </div>
    </section>
  );
}
