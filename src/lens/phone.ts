/**
 * The phone-side page (what the Even app shows on the phone while the lens runs): the gateway address and
 * token, and the connection status. The only place the token is ever entered.
 */
import type { GatewayProfile } from '../gateway/client';
import type { Conn } from './state';

export interface PhoneView {
  profile: GatewayProfile | null;
  conn: Conn;
  errors: string[];
}

const STATUS: Record<Conn, string> = {
  unconfigured: 'Not configured',
  connecting: 'Connecting',
  online: 'Connected',
  reconnecting: 'Reconnecting',
};

/** The page built for each root, so a re-render updates it in place. */
const built = new WeakMap<HTMLElement, { status: HTMLElement; errors: HTMLElement }>();

const statusClass = (c: Conn): string =>
  `setup-status ${c === 'online' ? 'is-connected' : c === 'unconfigured' ? 'is-muted' : 'is-pending'}`;

function fillErrors(list: HTMLElement, errors: string[]): void {
  list.replaceChildren(...errors.map((e) => el('li', '', e)));
  list.hidden = errors.length === 0;
}

/**
 * Draw the phone page. The form is built ONCE per root; later calls only update the status badge and the
 * error list. Rebuilding it on every status change (the socket flips connecting/reconnecting every few
 * seconds while it retries) wiped the field being typed into: on Codec a 64-character token was saved
 * as its first 44 characters (SC-9500, 2026-11-11).
 */
export function renderPhone(root: HTMLElement, v: PhoneView, onSave: (p: GatewayProfile) => void): void {
  const existing = built.get(root);
  if (existing && root.contains(existing.status)) {
    existing.status.className = statusClass(v.conn);
    existing.status.textContent = STATUS[v.conn];
    fillErrors(existing.errors, v.errors);
    return;
  }
  const shell = el('main', 'setup-shell');
  const panel = el('section', 'setup-panel');
  const header = el('header', 'setup-header');
  const status = el('p', statusClass(v.conn), STATUS[v.conn]);
  header.append(
    el('div', 'setup-title', '', [el('h1', '', 'Agent'), el('p', 'setup-copy', 'Aristo sessions on the glasses')]),
    status,
  );

  const form = el('form', 'setup-form');
  const url = input('url', 'url', v.profile?.url ?? '', 'wss://agent.alastor.space');
  const token = input('password', 'token', v.profile?.token ?? '', 'Gateway token');
  const save = document.createElement('button');
  save.type = 'submit';
  save.textContent = 'Save and connect';
  form.append(labelled('Gateway URL', url), labelled('Token', token), el('div', 'setup-actions', '', [save]));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    onSave({ url: url.value, token: token.value });
  });

  const errors = el('ul', 'setup-errors');
  fillErrors(errors, v.errors);

  panel.append(header, errors, form);
  shell.append(panel);
  root.replaceChildren(shell);
  built.set(root, { status, errors });
}

function input(type: string, name: string, value: string, placeholder: string): HTMLInputElement {
  const i = document.createElement('input');
  i.type = type;
  i.name = name;
  i.id = `lens-${name}`;
  i.value = value;
  i.placeholder = placeholder;
  i.autocomplete = 'off';
  i.autocapitalize = 'none';
  i.spellcheck = false;
  return i;
}

function labelled(text: string, control: HTMLInputElement): HTMLLabelElement {
  const l = document.createElement('label');
  l.append(el('span', '', text), control);
  return l;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = '',
  text = '',
  kids: HTMLElement[] = [],
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  if (kids.length) e.append(...kids);
  return e;
}
