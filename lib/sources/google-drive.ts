// lib/sources/google-drive.ts
//
// Google Drive source: syncs the files directly inside one folder (by
// Folder ID) via a Service Account, using the `googleapis` SDK. NOT
// recursive into subfolders -- a deliberate MVP boundary (CLAUDE.md: "без
// рекурсии по вложенным папкам"), documented in README. A subfolder
// encountered in the listing is reported back as skipped, never descended
// into.
//
// Auth: the full service-account JSON key is stored encrypted per-user
// (lib/sources/credentials.ts) and used to build a `google.auth.GoogleAuth`
// client scoped to `drive.readonly` -- this project never requests write
// access to the user's Drive.

import "server-only";
import { google, type drive_v3 } from "googleapis";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SourceError, safeErrorForLog } from "./errors";
import { getSourceCredential } from "./credentials";
import { detectExtractionType, extractText } from "./text-extraction";
import type { NormalizedDocument } from "./types";

const DRIVE_PAGE_SIZE = 100;
const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const GOOGLE_DOC_EXPORT_MIME = "text/plain";
const FOLDER_MIME = "application/vnd.google-apps.folder";

// What this pipeline can actually turn into text further down the line
// (CLAUDE.md: "поддерживаемые типы файлов... ограничены тем, что реально
// парсится дальше"). Sheets/Slides/Forms/images/etc. are all skipped, not
// silently ignored -- see syncGoogleDriveFolder's `skipped` results.
const SUPPORTED_MIME_TYPES = new Set([GOOGLE_DOC_MIME, "application/pdf", "text/plain", "text/markdown"]);

export interface DriveSyncSkipped {
  fileId: string;
  name: string;
  mimeType: string;
  reason: string;
}

export interface DriveSyncResult {
  imported: NormalizedDocument[];
  skipped: DriveSyncSkipped[];
}

/**
 * Format-only check for a Google Drive credential BEFORE it's ever
 * encrypted/stored -- a service-account key is JSON, so this is worth
 * checking eagerly at save time rather than only discovering it's garbage
 * the next time syncGoogleDriveFolder tries to use it (buildDriveClient's
 * own JSON.parse below still exists as a defense-in-depth backstop for
 * stored/decrypted corruption, not as the only place this is checked).
 *
 * app/api/sources/credentials/route.ts calls this as a per-source
 * validateCredentialFormat hook instead of special-casing
 * `sourceType === "google_drive"` and parsing JSON inline itself -- the
 * route knows THAT some sources have a format worth validating, never the
 * specifics of what that format is. Notion's Internal Integration Secret
 * has no equivalent hook: it's an opaque bearer string, nothing to
 * structurally validate before calling the Notion API with it.
 */
export function isValidGoogleDriveCredentialFormat(credential: string): boolean {
  try {
    JSON.parse(credential);
    return true;
  } catch {
    return false;
  }
}

async function buildDriveClient(supabase: SupabaseClient, userId: string): Promise<drive_v3.Drive> {
  const credentialJson = await getSourceCredential(supabase, userId, "google_drive");
  if (!credentialJson) {
    throw new SourceError({
      source: "google_drive",
      kind: "unauthorized",
      message: `no stored google_drive credential for user ${userId}`,
      userMessage: "Сначала подключите Google Drive: добавьте JSON-ключ сервисного аккаунта в настройках источников.",
    });
  }

  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(credentialJson);
  } catch {
    // Should be unreachable in practice (app/api/sources/credentials/route.ts
    // validates JSON.parse() succeeds before storing it), but decrypt
    // failures/corruption are still handled here rather than crashing.
    throw new SourceError({
      source: "google_drive",
      kind: "invalid_input",
      message: "stored google_drive credential is not valid JSON",
      userMessage: "Сохранённый ключ сервисного аккаунта повреждён. Добавьте его заново в настройках источников.",
    });
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  return google.drive({ version: "v3", auth });
}

function translateDriveError(err: unknown, context: string): SourceError {
  const status =
    (err as { code?: number } | undefined)?.code ?? (err as { response?: { status?: number } } | undefined)?.response?.status;

  if (status === 404) {
    return new SourceError({
      source: "google_drive",
      kind: "not_shared",
      message: `google drive 404 (${context})`,
      userMessage:
        "Папка или файл не найдены, либо не расшарены на email сервисного аккаунта. В Google Drive: 'Поделиться' -> добавьте email из поля client_email вашего JSON-ключа с правом 'Читатель'.",
      cause: err,
      status: 404,
    });
  }
  if (status === 403) {
    return new SourceError({
      source: "google_drive",
      kind: "not_shared",
      message: `google drive 403 (${context})`,
      userMessage:
        "Нет доступа -- убедитесь, что папка расшарена на email сервисного аккаунта (поле client_email в JSON-ключе) с правом хотя бы 'Читатель'.",
      cause: err,
      status: 403,
    });
  }
  if (status === 401) {
    return new SourceError({
      source: "google_drive",
      kind: "unauthorized",
      message: `google drive 401 (${context})`,
      userMessage: "Ключ сервисного аккаунта недействителен. Проверьте JSON-ключ в настройках источников.",
      cause: err,
      status: 401,
    });
  }
  return new SourceError({
    source: "google_drive",
    kind: "unknown",
    message: `google drive error (${context}): ${err instanceof Error ? err.message : String(err)}`,
    userMessage: "Не удалось получить данные из Google Drive.",
    cause: err,
  });
}

/** Lists files directly inside `folderId` -- explicitly NOT recursive (see module header). A subfolder shows up in this listing (mimeType = FOLDER_MIME) and is reported as skipped by the caller, never descended into. */
async function listFolderFiles(drive: drive_v3.Drive, folderId: string): Promise<drive_v3.Schema$File[]> {
  const files: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;
  do {
    let response;
    try {
      response = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType, modifiedTime)",
        pageSize: DRIVE_PAGE_SIZE,
        pageToken,
      });
    } catch (err) {
      throw translateDriveError(err, `files.list(${folderId})`);
    }
    files.push(...(response.data.files ?? []));
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);
  return files;
}

async function downloadFileBuffer(drive: drive_v3.Drive, fileId: string): Promise<Buffer> {
  try {
    const response = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
    return Buffer.from(response.data as ArrayBuffer);
  } catch (err) {
    throw translateDriveError(err, `files.get(${fileId})`);
  }
}

async function exportGoogleDoc(drive: drive_v3.Drive, fileId: string): Promise<string> {
  try {
    const response = await drive.files.export({ fileId, mimeType: GOOGLE_DOC_EXPORT_MIME }, { responseType: "text" });
    return String(response.data);
  } catch (err) {
    throw translateDriveError(err, `files.export(${fileId})`);
  }
}

/** Downloads/exports and extracts text for one file whose mimeType is already known to be in SUPPORTED_MIME_TYPES. Throws SourceError on any failure -- callers decide whether that's fatal (single-file refresh) or a per-file skip (folder sync). */
async function extractDriveFileText(drive: drive_v3.Drive, fileId: string, mimeType: string, name: string): Promise<string> {
  if (mimeType === GOOGLE_DOC_MIME) {
    return exportGoogleDoc(drive, fileId);
  }
  const buffer = await downloadFileBuffer(drive, fileId);
  const extractionType = detectExtractionType(name, mimeType);
  if (!extractionType) {
    throw new SourceError({
      source: "google_drive",
      kind: "unsupported_file_type",
      message: `could not determine extraction type for ${name} (${mimeType})`,
      userMessage: "Не удалось определить тип содержимого файла.",
    });
  }
  return extractText(buffer, extractionType);
}

/**
 * Syncs one Drive folder (by id), non-recursively (see module header).
 * Every file with a supported mime type is downloaded/exported and
 * extracted to plain text; anything else (subfolders, Sheets/Slides/Forms,
 * images, etc.) is skipped and reported in `skipped` with a
 * human-readable reason instead of failing the whole sync for one
 * unsupported file (CLAUDE.md: "файлы неподдерживаемых форматов
 * пропускаются с понятным логом, не роняют всю синхронизацию").
 */
export async function syncGoogleDriveFolder(
  supabase: SupabaseClient,
  userId: string,
  folderId: string
): Promise<DriveSyncResult> {
  const drive = await buildDriveClient(supabase, userId);
  const files = await listFolderFiles(drive, folderId);

  const imported: NormalizedDocument[] = [];
  const skipped: DriveSyncSkipped[] = [];

  for (const file of files) {
    const fileId = file.id;
    const name = file.name ?? "(untitled)";
    const mimeType = file.mimeType ?? "";
    if (!fileId) continue;

    if (mimeType === FOLDER_MIME) {
      skipped.push({ fileId, name, mimeType, reason: "Вложенные папки не синхронизируются в MVP (без рекурсии)." });
      continue;
    }
    if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
      skipped.push({
        fileId,
        name,
        mimeType,
        reason: `Неподдерживаемый тип файла (${mimeType || "неизвестен"}) -- поддерживаются PDF, .txt, .md и Google Docs.`,
      });
      continue;
    }

    try {
      const text = await extractDriveFileText(drive, fileId, mimeType, name);
      if (!text.trim()) {
        skipped.push({ fileId, name, mimeType, reason: "Файл не содержит извлекаемого текста." });
        continue;
      }
      imported.push({ title: name, text: text.trim(), sourceType: "google_drive", sourceRef: fileId });
    } catch (err) {
      // One file's extraction failure must not abort the whole folder sync
      // -- log and continue. Logged via safeErrorForLog(), never the raw
      // `err` (see that function's doc comment for why: a Drive failure's
      // `.cause` can carry a live OAuth token).
      console.error(`syncGoogleDriveFolder: failed to process file ${fileId} (${name}):`, safeErrorForLog(err));
      const reason = err instanceof SourceError ? err.userMessage : "Не удалось обработать файл.";
      skipped.push({ fileId, name, mimeType, reason });
    }
  }

  if (files.length === 0) {
    // An empty folder is indistinguishable from "not shared with the
    // service account" -- Drive's API returns zero files for a folder id
    // it can't see, same as for a genuinely empty one, with no separate
    // error. Surface this explicitly so a user who forgot to share the
    // folder doesn't just see a silent no-op.
    throw new SourceError({
      source: "google_drive",
      kind: "empty_content",
      message: `folder ${folderId} returned zero files`,
      userMessage:
        "Папка пуста, либо не расшарена на email сервисного аккаунта -- проверьте доступ (см. README) и что в папке есть файлы поддерживаемых форматов.",
    });
  }

  return { imported, skipped };
}

/** Re-fetches ONE previously-imported Drive file by id (used by the generic "Refresh" endpoint for a single google_drive document -- see app/api/sources/[documentId]/refresh/route.ts). Unlike syncGoogleDriveFolder, a failure here is fatal (there's no batch to fall back on). */
export async function importSingleDriveFile(supabase: SupabaseClient, userId: string, fileId: string): Promise<NormalizedDocument> {
  const drive = await buildDriveClient(supabase, userId);

  let metadata;
  try {
    metadata = await drive.files.get({ fileId, fields: "id, name, mimeType" });
  } catch (err) {
    throw translateDriveError(err, `files.get(${fileId}, metadata)`);
  }
  const name = metadata.data.name ?? "(untitled)";
  const mimeType = metadata.data.mimeType ?? "";

  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new SourceError({
      source: "google_drive",
      kind: "unsupported_file_type",
      message: `file ${fileId} has unsupported mimeType ${mimeType}`,
      userMessage: `Неподдерживаемый тип файла (${mimeType || "неизвестен"}).`,
    });
  }

  const text = await extractDriveFileText(drive, fileId, mimeType, name);
  if (!text.trim()) {
    throw new SourceError({
      source: "google_drive",
      kind: "empty_content",
      message: `file ${fileId} (${name}) has no extractable text`,
      userMessage: "Файл не содержит извлекаемого текста.",
    });
  }

  return { title: name, text: text.trim(), sourceType: "google_drive", sourceRef: fileId };
}
