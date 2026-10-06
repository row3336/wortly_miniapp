export type DocumentLease = { release(): void };
export type LockResult = DocumentLease | "unsupported";
export interface DocumentLock {
  /**
   * Takes the cross-window lock of one installation's document, from any window that holds it. onLost runs when a
   * newer window takes it away; a lease given back by release() never calls it.
   */
  acquire(key: string, onLost: () => void): Promise<LockResult>;
}

export function browserDocumentLock(nav: Navigator): DocumentLock {
  return {
    async acquire(key, onLost) {
      if (!nav.locks) return "unsupported";
      return new Promise<LockResult>((resolve) => {
        let release: (() => void) | undefined;
        let granted = false;
        const hold = new Promise<void>((done) => { release = done; });
        // A new window never waits for the old one (decision 2.3): steal ends the holder's request with AbortError,
        // which tells that window at once that its document was replaced.
        nav.locks.request(`wortly-document:${key}`, { steal: true }, async () => {
          granted = true;
          resolve({ release: () => release?.() });
          await hold;
        }).catch(() => {
          if (granted) onLost();
          else resolve("unsupported");
        });
      });
    },
  };
}
