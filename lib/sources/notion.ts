// lib/sources/notion.ts
//
// Notion source: imports a page or database by URL/id via the official
// @notionhq/client SDK, using the caller's own Internal Integration Secret
// (stored encrypted per-user, see lib/sources/credentials.ts). Nested
// blocks / sub-pages are followed up to MAX_RECURSION_DEPTH, not
// indefinitely (CLAUDE.md: "на разумную глубину, не бесконечная рекурсия
// по всему workspace") -- a Notion workspace can have pages nested many
// levels deep with circular-ish "linked" structures, and importing one
// page should not risk pulling in a large fraction of the workspace.

import "server-only";
import { Client, isFullBlock, isFullDatabase, isFullPage } from "@notionhq/client";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  BlockObjectResponse,
  PageObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints";
import { SourceError } from "./errors";
import { getSourceCredential } from "./credentials";
import type { NormalizedDocument } from "./types";

/** page/sub-page/sub-sub-page -- see module header. */
const MAX_RECURSION_DEPTH = 3;
/** Caps a single database import so one enormous database (thousands of rows) can't turn one "import" click into an unbounded, slow, expensive operation. */
const MAX_DATABASE_ROWS = 200;
const NOTION_PAGE_SIZE = 100;

function richTextToPlainText(richText: RichTextItemResponse[] | undefined): string {
  return (richText ?? []).map((t) => t.plain_text).join("");
}

/**
 * Accepts either a bare 32-hex-char id (dashed or not) or a full
 * notion.so URL and extracts the id. Notion always appends the id as the
 * last 32 hex characters of the URL path (after the human-readable
 * slug) -- e.g. ".../My-Page-83c75a51e7f5470eb9d67d5a26b8b0f5" or
 * ".../My-Page-83c75a51e7f5470eb9d67d5a26b8b0f5?pvs=4".
 */
function extractNotionId(input: string): string {
  const trimmed = input.trim();
  const hexMatch = trimmed.replace(/-/g, "").match(/([0-9a-fA-F]{32})(?:[?#]|$)/);
  const idSource = (hexMatch ? hexMatch[1] : trimmed.replace(/-/g, "")).toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(idSource)) {
    throw new SourceError({
      source: "notion",
      kind: "invalid_input",
      message: `could not extract a Notion page/database id from "${input}"`,
      userMessage:
        "Не удалось распознать ссылку на страницу или базу Notion. Скопируйте ссылку через Notion 'Share' -> 'Copy link'.",
    });
  }
  return [idSource.slice(0, 8), idSource.slice(8, 12), idSource.slice(12, 16), idSource.slice(16, 20), idSource.slice(20, 32)].join(
    "-"
  );
}

async function buildClient(supabase: SupabaseClient, userId: string): Promise<Client> {
  const token = await getSourceCredential(supabase, userId, "notion");
  if (!token) {
    throw new SourceError({
      source: "notion",
      kind: "unauthorized",
      message: `no stored notion credential for user ${userId}`,
      userMessage: "Сначала подключите Notion: добавьте Internal Integration Secret в настройках источников.",
    });
  }
  // `token` is a decrypted secret from this point on -- never logged,
  // never included in a thrown error, never returned from this module.
  return new Client({ auth: token });
}

function translateNotionError(err: unknown): SourceError {
  const status = (err as { status?: number } | undefined)?.status;
  const code = (err as { code?: string } | undefined)?.code;

  if (status === 401) {
    return new SourceError({
      source: "notion",
      kind: "unauthorized",
      message: `notion API 401${err instanceof Error ? `: ${err.message}` : ""}`,
      userMessage: "Notion Integration Secret недействителен. Проверьте токен в настройках источников.",
      cause: err,
      status,
    });
  }
  if (status === 404 || code === "object_not_found") {
    // Notion deliberately returns 404 for BOTH "doesn't exist" and "exists
    // but isn't shared with this integration" (so a token can't be used to
    // probe for pages it can't see) -- there is no way to tell these apart
    // from the API response alone. The message below covers the
    // actually-common real case explicitly, per CLAUDE.md's "понятная
    // ошибка... а не глухой 403 без объяснения" requirement, rather than
    // surfacing a bare, unexplained 404.
    return new SourceError({
      source: "notion",
      kind: "not_shared",
      message: "notion API 404 / object_not_found",
      userMessage:
        "Страница или база не найдена, либо не расшарена на интеграцию. В Notion откройте страницу -> '...' (или 'Share') -> 'Connections' -> выберите вашу интеграцию, затем повторите попытку.",
      cause: err,
      status: 404,
    });
  }
  if (status === 429) {
    return new SourceError({
      source: "notion",
      kind: "upstream_error",
      message: "notion API 429",
      userMessage: "Notion временно ограничил запросы, попробуйте позже.",
      cause: err,
      status: 429,
    });
  }
  return new SourceError({
    source: "notion",
    kind: "unknown",
    message: `notion API error: ${err instanceof Error ? err.message : String(err)}`,
    userMessage: "Не удалось получить данные из Notion.",
    cause: err,
  });
}

async function fetchBlockChildrenText(client: Client, blockId: string, depth: number): Promise<string> {
  if (depth > MAX_RECURSION_DEPTH) return "";
  const parts: string[] = [];
  let cursor: string | undefined;
  do {
    let page;
    try {
      page = await client.blocks.children.list({ block_id: blockId, start_cursor: cursor, page_size: NOTION_PAGE_SIZE });
    } catch (err) {
      throw translateNotionError(err);
    }
    for (const block of page.results) {
      if (!isFullBlock(block)) continue; // partial results (insufficient permission on a specific block) -- skip rather than crash
      const text = await blockToText(client, block, depth);
      if (text) parts.push(text);
    }
    cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
  } while (cursor);
  return parts.join("\n\n");
}

async function blockToText(client: Client, block: BlockObjectResponse, depth: number): Promise<string> {
  const lines: string[] = [];

  switch (block.type) {
    case "paragraph":
      lines.push(richTextToPlainText(block.paragraph.rich_text));
      break;
    case "heading_1":
      lines.push(`# ${richTextToPlainText(block.heading_1.rich_text)}`);
      break;
    case "heading_2":
      lines.push(`## ${richTextToPlainText(block.heading_2.rich_text)}`);
      break;
    case "heading_3":
      lines.push(`### ${richTextToPlainText(block.heading_3.rich_text)}`);
      break;
    case "bulleted_list_item":
      lines.push(`- ${richTextToPlainText(block.bulleted_list_item.rich_text)}`);
      break;
    case "numbered_list_item":
      lines.push(`- ${richTextToPlainText(block.numbered_list_item.rich_text)}`);
      break;
    case "to_do":
      lines.push(`[${block.to_do.checked ? "x" : " "}] ${richTextToPlainText(block.to_do.rich_text)}`);
      break;
    case "toggle":
      lines.push(richTextToPlainText(block.toggle.rich_text));
      break;
    case "quote":
      lines.push(`> ${richTextToPlainText(block.quote.rich_text)}`);
      break;
    case "callout":
      lines.push(richTextToPlainText(block.callout.rich_text));
      break;
    case "code":
      lines.push(richTextToPlainText(block.code.rich_text));
      break;
    case "table_row":
      lines.push(block.table_row.cells.map((cell) => richTextToPlainText(cell)).join(" | "));
      break;
    case "divider":
      break;
    case "child_page":
      // A linked sub-page block: descend into it up to the depth limit,
      // otherwise note its title only (see module header).
      lines.push(`\n## ${block.child_page.title}`);
      if (depth < MAX_RECURSION_DEPTH) {
        const childText = await fetchBlockChildrenText(client, block.id, depth + 1);
        if (childText) lines.push(childText);
      } else {
        lines.push("_(вложенная страница пропущена: превышена максимальная глубина импорта)_");
      }
      return lines.join("\n");
    case "child_database":
      // An inline sub-database block -- not expanded (a nested database
      // could itself contain hundreds of rows; importing it top-level via
      // importNotionDocument() is the supported path for that content).
      lines.push(`\n## ${block.child_database.title} (вложенная база данных Notion -- не импортирована автоматически)`);
      return lines.join("\n");
    default:
      // Forward-compatible: unrecognized/unsupported block types (embeds,
      // images, files, synced blocks, new block types Notion adds later,
      // ...) are silently skipped rather than throwing -- losing a
      // caption/media reference is an acceptable trade-off for not
      // crashing the whole import on a block type this adapter doesn't
      // know how to flatten to text.
      break;
  }

  if (block.has_children && depth <= MAX_RECURSION_DEPTH) {
    const childText = await fetchBlockChildrenText(client, block.id, depth + 1);
    if (childText) lines.push(childText);
  }

  return lines.filter(Boolean).join("\n");
}

function extractPageTitle(page: PageObjectResponse): string {
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title") return richTextToPlainText(prop.title) || "Untitled";
  }
  return "Untitled";
}

async function importNotionPage(client: Client, pageId: string): Promise<{ title: string; text: string }> {
  let page;
  try {
    page = await client.pages.retrieve({ page_id: pageId });
  } catch (err) {
    throw translateNotionError(err);
  }
  if (!isFullPage(page)) {
    throw new SourceError({
      source: "notion",
      kind: "unauthorized",
      message: `partial page response for ${pageId} (integration lacks full read access)`,
      userMessage: "Недостаточно прав интеграции для чтения этой страницы целиком.",
    });
  }
  const title = extractPageTitle(page);
  const text = await fetchBlockChildrenText(client, pageId, 1);
  return { title, text };
}

async function importNotionDatabase(client: Client, databaseId: string): Promise<{ title: string; text: string }> {
  let database;
  try {
    database = await client.databases.retrieve({ database_id: databaseId });
  } catch (err) {
    throw translateNotionError(err);
  }
  if (!isFullDatabase(database)) {
    throw new SourceError({
      source: "notion",
      kind: "unauthorized",
      message: `partial database response for ${databaseId}`,
      userMessage: "Недостаточно прав интеграции для чтения этой базы данных целиком.",
    });
  }
  const title = richTextToPlainText(database.title) || "Untitled database";

  // As of Notion API version 2025-09-03, a "database" no longer holds rows
  // directly -- rows live in one or more "data sources" attached to it
  // (the multi-source-database feature), and `databases.query` was removed
  // from the SDK entirely in favor of `dataSources.query({data_source_id})`.
  // This adapter only supports the common case (a single data source per
  // database, true for every database created the traditional way / not
  // opted into multi-source) -- it queries the FIRST data source only. A
  // database with multiple data sources would silently only import the
  // first one's rows; flagged here rather than fully implementing
  // multi-data-source fan-out, which is a rare, newer Notion feature.
  const dataSourceId = database.data_sources[0]?.id;
  if (!dataSourceId) {
    throw new SourceError({
      source: "notion",
      kind: "empty_content",
      message: `database ${databaseId} has no data sources`,
      userMessage: "В этой базе данных Notion нет данных для импорта.",
    });
  }

  const rows: string[] = [];
  let cursor: string | undefined;
  let fetched = 0;
  do {
    let queryResult;
    try {
      queryResult = await client.dataSources.query({
        data_source_id: dataSourceId,
        start_cursor: cursor,
        page_size: Math.min(NOTION_PAGE_SIZE, MAX_DATABASE_ROWS - fetched),
      });
    } catch (err) {
      throw translateNotionError(err);
    }
    for (const row of queryResult.results) {
      if (!isFullPage(row)) continue;
      const rowTitle = extractPageTitle(row);
      // Each row's own content is fetched at the deepest allowed level --
      // database rows aren't recursed into further sub-pages beyond that,
      // keeping one database import bounded even if individual rows link
      // deep sub-page trees of their own.
      const rowBody = await fetchBlockChildrenText(client, row.id, MAX_RECURSION_DEPTH);
      rows.push(`## ${rowTitle}\n${rowBody}`.trim());
      fetched++;
      if (fetched >= MAX_DATABASE_ROWS) break;
    }
    cursor = queryResult.has_more && fetched < MAX_DATABASE_ROWS ? queryResult.next_cursor ?? undefined : undefined;
  } while (cursor);

  return { title, text: rows.join("\n\n") };
}

/**
 * Imports one Notion page or database by URL/id. `sourceRef` on the
 * result is the normalized (dashed) Notion id -- what "Refresh" re-fetches
 * against on subsequent calls.
 */
export async function importNotionDocument(
  supabase: SupabaseClient,
  userId: string,
  pageUrlOrId: string
): Promise<NormalizedDocument> {
  const id = extractNotionId(pageUrlOrId);
  const client = await buildClient(supabase, userId);

  let result: { title: string; text: string };
  try {
    result = await importNotionPage(client, id);
  } catch (pageErr) {
    if (pageErr instanceof SourceError && pageErr.kind === "not_shared") {
      // Page ids and database ids share the same 32-hex-char format and
      // the URL alone doesn't say which one this is -- try the database
      // endpoint before surfacing an error to the user.
      try {
        result = await importNotionDatabase(client, id);
      } catch {
        throw pageErr; // report the original (page) "not shared" error -- equally applicable to a database
      }
    } else {
      throw pageErr;
    }
  }

  if (!result.text.trim()) {
    throw new SourceError({
      source: "notion",
      kind: "empty_content",
      message: `page/database ${id} had no extractable text`,
      userMessage: "На странице Notion не найдено текстового содержимого.",
    });
  }

  return { title: result.title, text: result.text, sourceType: "notion", sourceRef: id };
}
