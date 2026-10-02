import "server-only";
import { config } from "./config";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type NotionPage = {
  id: string;
  last_edited_time?: string;
  parent?: { type: string; database_id?: string };
  properties: Record<string, any>;
};

async function notion(path: string, init: { method: string; body?: unknown }) {
  const res = await fetch(`${NOTION_API}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${config.notionToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion ${init.method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

/** Query every page of a database (follows pagination). */
export async function queryAll(
  databaseId: string,
  body: { filter?: unknown; sorts?: unknown } = {},
  maxPages = 20,
): Promise<NotionPage[]> {
  const results: NotionPage[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const data = await notion(`/databases/${databaseId}/query`, {
      method: "POST",
      body: { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
    });
    results.push(...data.results);
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return results;
}

/** Query one page of results (for "Load more" lists). */
export async function queryPage(
  databaseId: string,
  body: { filter?: unknown; sorts?: unknown },
  cursor?: string | null,
  pageSize = 50,
): Promise<{ results: NotionPage[]; nextCursor: string | null }> {
  const data = await notion(`/databases/${databaseId}/query`, {
    method: "POST",
    body: { ...body, page_size: pageSize, ...(cursor ? { start_cursor: cursor } : {}) },
  });
  return { results: data.results, nextCursor: data.has_more ? data.next_cursor : null };
}

export function getPage(pageId: string): Promise<NotionPage> {
  return notion(`/pages/${pageId}`, { method: "GET" });
}

export function updatePage(pageId: string, properties: Record<string, unknown>) {
  return notion(`/pages/${pageId}`, { method: "PATCH", body: { properties } });
}

/** Add a new row to a database. */
export function createPage(databaseId: string, properties: Record<string, unknown>): Promise<NotionPage> {
  return notion(`/pages`, { method: "POST", body: { parent: { database_id: databaseId }, properties } });
}

/* ---------- property readers ---------- */

function sameId(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return decodeURIComponent(a) === decodeURIComponent(b);
  } catch {
    return false;
  }
}

/**
 * Find a property on a page by its Notion property ID (preferred) or its name.
 * Notion returns properties keyed by name, but each one carries its stable `id`.
 */
export function findProp(page: NotionPage, key: string): any | undefined {
  for (const p of Object.values(page.properties)) {
    if (p && typeof p.id === "string" && sameId(p.id, key)) return p;
  }
  return page.properties[key];
}

export function readText(page: NotionPage, key: string): string {
  const p = findProp(page, key);
  if (!p) return "";
  const parts = p.type === "title" ? p.title : p.type === "rich_text" ? p.rich_text : null;
  if (parts) return parts.map((t: any) => t.plain_text).join("").trim();
  if (p.type === "email") return p.email ?? "";
  if (p.type === "select") return p.select?.name ?? "";
  return "";
}

export function readNumber(page: NotionPage, key: string): number | null {
  const p = findProp(page, key);
  return p?.type === "number" ? p.number : null;
}

export function readDate(page: NotionPage, key: string): string | null {
  const p = findProp(page, key);
  return p?.type === "date" ? (p.date?.start ?? null) : null;
}

export function readRelationIds(page: NotionPage, key: string): string[] {
  const p = findProp(page, key);
  return p?.type === "relation" ? p.relation.map((r: any) => r.id) : [];
}

/** Notion page IDs are 32 hex chars, optionally dashed. Reject anything else. */
export function isNotionId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-f]{32}$/i.test(id.replace(/-/g, ""));
}