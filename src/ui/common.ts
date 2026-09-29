// Shared helpers for the extension pages (popup and report). Extension pages
// only: no content scripts exist, and nothing here touches the network.
import catalogJson from '../catalog/catalog.json';
import suppressionJson from '../catalog/suppression.json';
import { buildMatcher, validateCatalog, type Matcher } from '../lib/catalog';
import type { Message, MessageResult } from '../lib/service';
import { dayKey } from '../lib/time';

export function loadMatcher(): { matcher: Matcher | null; errors: string[] } {
  const { catalog, errors } = validateCatalog(catalogJson);
  return { matcher: catalog ? buildMatcher(catalog) : null, errors };
}

export const suppression: ReadonlySet<string> = new Set(suppressionJson.domains);

export async function send(msg: Message): Promise<MessageResult> {
  try {
    return ((await chrome.runtime.sendMessage(msg)) as MessageResult | undefined) ?? { ok: false, error: 'no response' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Fold the open focus window first so the snapshot includes the current minute. */
export async function snapshot(): Promise<Record<string, unknown>> {
  await send({ type: 'flush' });
  return (await chrome.storage.local.get(null)) as Record<string, unknown>;
}

export function today(): string {
  return dayKey(Date.now());
}

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string; attrs?: Record<string, string>; on?: Record<string, (e: Event) => void> } = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) node.setAttribute(k, v);
  for (const [k, fn] of Object.entries(props.on ?? {})) node.addEventListener(k, fn);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function hours(seconds: number): string {
  const h = seconds / 3600;
  return h >= 10 ? h.toFixed(0) : h.toFixed(1);
}

/** Generated letter avatar: no logos, no favicons, no fetches. */
export function avatar(name: string): HTMLElement {
  const letter = (name.match(/[A-Za-z0-9]/)?.[0] ?? '?').toUpperCase();
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return el('span', { className: `avatar hue-${hash % 8}`, text: letter, attrs: { 'aria-hidden': 'true' } });
}

/** Drop empty children so conditional sections can be written inline. */
export function nodes(...children: Child[]): Array<Node | string> {
  return children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false);
}
