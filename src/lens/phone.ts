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

export function renderPhone(root: HTMLElement, v: PhoneView, onSave: (p: GatewayProfile) => void): void {
  const shell = el('main', 'setup-shell');
  const panel = el('section', 'setup-panel');
  const header = el('header', 'setup-header');
  header.append(
    el('div', 'setup-title', '', [
      el('h1', '', 'Aristo Lens'),
      el('p', 'setup-copy', 'Aristo sessions on the glasses'),
    ]),
    el(
      'p',
      `setup-status ${v.conn === 'online' ? 'is-connected' : v.conn === 'unconfigured' ? 'is-muted' : 'is-pending'}`,
      STATUS[v.conn],
    ),
  );

  const form = el('form', 'setup-form');
  const url = input('url', 'url', v.profile?.url ?? '', 'wss://chiba.tailb04065.ts.net:8445');
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
  for (const e of v.errors) errors.append(el('li', '', e));
  errors.hidden = v.errors.length === 0;

  panel.append(header, errors, form);
  shell.append(panel);
  root.replaceChildren(shell);
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
