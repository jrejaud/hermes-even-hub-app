import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { AppState, StreamItem } from "../state/store";
import { barText, connDot, isHistoryLoading } from "../state/store";
import { IDS, setText, showAlertPage, showListPage, showLoadingPage } from "./render";
import { LOADING_SESSIONS_ROW, sessionListRows, truncateTitle } from "./session-list";
import { clampToBudget, currentThreadViewport, wrapTextLines } from "./stream";

export function truncateRow(title: string): string {
  return truncateTitle(title);
}

export function listRows(s: AppState, nowSeconds?: number): string[] {
  if (!s.sessionsLoaded) return [LOADING_SESSIONS_ROW];
  return sessionListRows(s.sessions.items, s.sessions.active, nowSeconds, {
    hosts: s.hosts,
    unread: s.unread,
  });
}

export async function renderList(bridge: EvenAppBridge, s: AppState): Promise<void> {
  if (!s.sessionsLoaded) {
    await showLoadingPage(bridge, loadingText(s));
    return;
  }
  // Lists can't update in place — rebuild the page (glasses-ui).
  await showListPage(bridge, listRows(s));
}

export function loadingText(s: AppState): string {
  const status = s.conn === "connected"
    ? "waiting for session list"
    : s.conn;
  return `loading sessions...\n${status}`;
}

/**
 * The activity alert. Names the machine, because with several hosts in one list
 * "which one just finished" is the first thing you need and the last thing a
 * title tells you.
 */
export function alertText(s: AppState): string {
  const n = s.notice;
  if (!n) return "";
  const where = n.host ? `● ${n.host} · ` : "● ";
  const head = `${where}${truncateRow(n.title)}`;
  const body = n.preview.trim() ? n.preview : "(no preview)";
  return clampToBudget(wrapTextLines([head, "", body].join("\n")).concat(["", "tap = open · swipe↓ = dismiss"]));
}

export async function renderAlert(bridge: EvenAppBridge, s: AppState): Promise<void> {
  await showAlertPage(bridge, alertText(s));
}

export async function renderSession(bridge: EvenAppBridge, s: AppState): Promise<void> {
  const active = s.sessions.items.find((i) => i.id === s.sessions.active);
  const title = active && active.title.trim() ? truncateRow(active.title) : "Claude Code";
  const host = active?.host ? `${active.host} · ` : "";
  await setText(bridge, IDS.header, `${host}${title}`);
  await setText(bridge, IDS.dot, connDot(s.conn));

  const body = isHistoryLoading(s)
    ? "loading session..."
    : displayThreadItems(s).length === 0
      ? "tap to speak"
      : threadViewportText(s);
  await setText(bridge, IDS.body, body);

  await setText(bridge, IDS.status, statusText(s));
}

function threadViewportText(s: AppState): string {
  return currentThreadViewport(displayThreadItems(s), s.scrollPage).content;
}

function displayThreadItems(s: AppState): StreamItem[] {
  if (s.phase === "review" && s.pending) {
    return [...s.stream, { kind: "user", text: s.pending.transcript }];
  }
  return s.stream;
}

function statusText(s: AppState): string {
  const base = barText(s);
  const items = displayThreadItems(s);
  if (s.phase !== "idle" || items.length === 0) return base;

  const viewport = currentThreadViewport(items, s.scrollPage);
  const unread = s.unread.length ? ` · ${s.unread.length}*` : "";
  return viewport.total > 1 ? `${base} · ${viewport.index + 1}/${viewport.total}${unread}` : `${base}${unread}`;
}
