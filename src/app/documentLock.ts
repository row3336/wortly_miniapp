export type DocumentLease = { release(): void };
export type LockResult = DocumentLease | "busy" | "unsupported";
export interface DocumentLock {
  acquire(profileId: string): Promise<LockResult>;
}

export function browserDocumentLock(nav: Navigator): DocumentLock {
  return {
    async acquire(profileId) {
      if (!nav.locks) return "unsupported";
      return new Promise<LockResult>((resolve, reject) => {
        let release: (() => void) | undefined;
        const hold = new Promise<void>((done) => { release = done; });
        void nav.locks.request(`wortly-document:${profileId}`, { ifAvailable: true }, async (lock) => {
          if (!lock) { resolve("busy"); return; }
          resolve({ release: () => release?.() });
          await hold;
        }).catch(reject);
      });
    },
  };
}
