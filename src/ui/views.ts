import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { AppState, StreamItem } from "../state/store";
import { barText, connDot, isHistoryLoading } from "../state/store";
import { IDS, setText, showAlertPage, showListPage, showLoadingPage } from "./render";
import { getTextWidth } from "@evenrealities/pretext";
import { LOADING_SESSIONS_ROW, newSessionRows, orderedSessions, sessionListRows, truncateTitle } from "./session-list";
import { clampToBudget, currentThreadViewport, wrapTextLines } from "./stream";

/**
 * Usable width of the header text container: 540 wide, 4px padding each side.
 * The connection dot owns x=540..576 and must never be written under.
 */
const HEADER_TEXT_WIDTH_PX = 540 - 8;

export function truncateRow(title: string): string {
  return truncateTitle(title);
}

/**
 * What is on screen, and what each row MEANS.
 *
 * `rows` and `ids` are built together and must stay together: the glasses report
 * a tap as an INDEX into the rows they are currently displaying, and the session
 * list re-sorts by recency underneath us. Re-deriving the mapping from live
 * state at tap time therefore opens whatever is at that index NOW, which after
 * any reorder is a different session than the one under the wearer's finger.
 *
 * `ids[i]` is the session for row `i`, or null for the ＋New rows.
 */
export interface ListView {
  rows: string[];
  ids: (string | null)[];
  hostKeys: (string | null)[];
}

export function buildListView(s: AppState, nowSeconds?: number): ListView {
  if (!s.sessionsLoaded) return { rows: [LOADING_SESSIONS_ROW], ids: [null], hostKeys: [null] };

  const rows = sessionListRows(s.sessions.items, s.sessions.active, nowSeconds, {
    hosts: s.hosts,
    unread: s.unread,
  });
  const newRows = newSessionRows(s.hosts);
  const ordered = orderedSessions(s.sessions.items);
  return {
    rows,
    ids: [...newRows.map(() => null), ...ordered.map((i) => i.id)],
    hostKeys: [
      ...newRows.map((_, i) => (s.hosts.length > 1 ? (s.hosts[i]?.key ?? null) : null)),
      ...ordered.map(() => null),
    ],
  };
}

export function listRows(s: AppState, nowSeconds?: number): string[] {
  return buildListView(s, nowSeconds).rows;
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

/**
 * The header line, truncated as ONE string.
 *
 * Truncating the title alone and then prepending a host tag overflows the
 * container: the text wraps onto a second line, which the 40px-high header has
 * no room for, so it spills over the body's first line and the tail collides
 * with the connection dot. Seen in the state gallery, 2026-09-04 (frame
 * `15-session-long-title`) — and it is invisible until a title is long enough,
 * which is why it survived a working demo.
 */
export function headerText(host: string | undefined, title: string): string {
  const prefix = host ? `${host} · ` : "";
  return prefix + truncateTitle(title, HEADER_TEXT_WIDTH_PX - getTextWidth(prefix));
}

export async function renderSession(bridge: EvenAppBridge, s: AppState): Promise<void> {
  const active = s.sessions.items.find((i) => i.id === s.sessions.active);
  const title = active && active.title.trim() ? active.title : "Claude Code";
  await setText(bridge, IDS.header, headerText(active?.host, title));
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
