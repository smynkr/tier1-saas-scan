// Origin (seam only): smynkr/axiomlayer-oss apps/browser-extension/src/lib/storage.ts (archived snapshot)
// (single-author file). The KeyValueStorage interface and tolerant-load style are
// reused; the upload queue, heartbeat and tracker-state blobs are dropped.

/**
 * The subset of chrome.storage.StorageArea this extension needs. Pure logic is
 * tested against MemoryStorage; the service worker passes an adapter over the
 * real chrome.storage.local / chrome.storage.session.
 */
export interface KeyValueStorage {
  /** null = every key. */
  get(keys: string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
  clear(): Promise<void>;
  getBytesInUse(): Promise<number>;
}

/** In-memory fake that mirrors chrome.storage semantics (structured-clone on read/write). */
export class MemoryStorage implements KeyValueStorage {
  private data = new Map<string, string>();

  async get(keys: string[] | null): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    const wanted = keys ?? [...this.data.keys()];
    for (const k of wanted) {
      const raw = this.data.get(k);
      if (raw !== undefined) out[k] = JSON.parse(raw);
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) {
      if (v === undefined) continue;
      this.data.set(k, JSON.stringify(v));
    }
  }

  async remove(keys: string[]): Promise<void> {
    for (const k of keys) this.data.delete(k);
  }

  async clear(): Promise<void> {
    this.data.clear();
  }

  /** Approximates Chrome's accounting: key length + JSON length of the value. */
  async getBytesInUse(): Promise<number> {
    let n = 0;
    for (const [k, v] of this.data) n += k.length + v.length;
    return n;
  }

  keys(): string[] {
    return [...this.data.keys()];
  }

  /** Raw serialized dump, used by the Tier-1 canary tests. */
  dump(): string {
    return JSON.stringify(Object.fromEntries(this.data));
  }
}
