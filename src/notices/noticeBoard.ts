import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import type { NoticeView } from "../api/generated";
import type { HttpOptions } from "../api/http";
import { sameId } from "../api/wireValidation";
import type { OpenedAccess } from "../app/openedAccess";
import { createNoticeApi, noticeOrder, type NoticeApi, type NoticeKind } from "./noticeApi";

/**
 * The pending notices of one opened document (project notices ed.2.4 §5, §6, §6.1; CON §7.2 п.4).
 *
 * Sources: the `notices` of every client.open of this document (they come when the client opens), and GET /notices, read
 * only when the window needs it — after a NOTICE_PENDING refusal of a start, or after an oral session of this window was
 * closed without the person (Т2: after a confirmed closure GET /notices is the source). The latest server list wins; a
 * notice this document already ended (acknowledged, or 404) is never shown again from an older list.
 *
 * Nothing here acknowledges by itself: acknowledge() is called only from the press of «Далее» / «На „Сегодня“» (§5:
 * showing is no acknowledgement). A failed read repeats only the read (Т2): no Stop, no answer, no start is sent from
 * here; the window offers the repeat of the read and nothing else.
 */
export type NoticeBoardSnapshot = {
  /** Pending, oldest first (created_at, notice_id), without those ended in this document. */
  notices: readonly NoticeView[];
  read: "idle" | "reading" | "failed";
  /** A read the window waits for before it shows Today again (NOTICE_PENDING, an oral forced closure). */
  required: boolean;
  /** The notice whose acknowledgement is under way. */
  acking: string | null;
};

export class NoticeBoard {
  private list: NoticeView[] = [];
  private readonly ended = new Set<string>();
  private readonly commandIds = new Map<string, string>();
  private readonly seen = new WeakSet<OpenedAccess>();
  private access: OpenedAccess | null = null;
  private reading: Promise<boolean> | null = null;
  private readState: NoticeBoardSnapshot["read"] = "idle";
  private required = false;
  private acking: string | null = null;
  private serial = 0;
  private snapshot: NoticeBoardSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: { api: NoticeApi; newId(): string; access?: OpenedAccess }) {
    this.snapshot = this.make();
    if (options.access) this.observe(options.access);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = (): NoticeBoardSnapshot => this.snapshot;

  /** Whether this access's own `notices` were taken already (until then a render reads them directly: pendingOf). */
  hasSeen(access: OpenedAccess): boolean { return this.seen.has(access); }

  /** The pending of an access not observed yet, filtered as the board would. */
  pendingOf(access: OpenedAccess): readonly NoticeView[] {
    const notices = access.notices;
    return notices === undefined || notices === null ? this.snapshot.notices : this.filter(notices);
  }

  /** A new client.open of this document: its `notices` are the newest server list (absent from an older core: kept). */
  observe(access: OpenedAccess): void {
    this.access = access;
    if (this.seen.has(access)) return;
    this.seen.add(access);
    const notices = access.notices;
    if (notices === undefined || notices === null) return;
    this.serial++;
    this.list = noticeOrder(notices);
    this.emit();
  }

  /** The window must not show Today before a fresh GET /notices answered (NOTICE_PENDING, §6.1). */
  require(): void {
    this.required = true;
    this.emit();
    void this.read();
  }

  /** One GET /notices; concurrent calls join it. A failure leaves the list as it was and only this read to repeat (Т2). */
  read(): Promise<boolean> {
    if (this.reading) return this.reading;
    const access = this.access;
    if (!access || !access.isLive()) {
      this.readState = "failed"; this.emit();
      return Promise.resolve(false);
    }
    const serial = ++this.serial;
    this.readState = "reading"; this.emit();
    const task = access.run(({ token }) => this.options.api.pending(token)).then(notices => {
      // A newer client.open answered meanwhile: its list is the newer one.
      if (serial === this.serial) this.list = noticeOrder(notices);
      this.readState = "idle"; this.required = false;
      return true;
    }, () => {
      this.readState = "failed";
      return false;
    }).finally(() => {
      if (this.reading === task) this.reading = null;
      this.emit();
    });
    this.reading = task;
    return task;
  }

  /** The pending notice of one closed session, if the board knows it. */
  find(sessionId: string, kind: NoticeKind): NoticeView | null {
    return this.snapshot.notices.find(notice => notice.kind === kind && sameId(notice.session_id, sessionId)) ?? null;
  }

  /**
   * The acknowledgement after the person's press (§5, §6): true once it ended (applied / already_applied, or 404 — then
   * nothing of it is shown any more); false when it did not (the notice stays and is shown again, §5). One at a time.
   */
  async acknowledge(noticeId: string): Promise<boolean> {
    const access = this.access;
    if (this.acking !== null || !access || !access.isLive()) return false;
    const key = noticeId.toLowerCase();
    if (this.ended.has(key)) return true;
    let commandId = this.commandIds.get(key);
    if (commandId === undefined) { commandId = this.options.newId(); this.commandIds.set(key, commandId); }
    this.acking = noticeId; this.emit();
    try {
      const end = await access.run(({ token, proof, clientInstanceId }) =>
        this.options.api.ack(token, proof, noticeId, { command_id: commandId!, client_instance_id: clientInstanceId }));
      if (end.kind === "failed") return false;
      this.ended.add(key);
      return true;
    } catch {
      return false;
    } finally {
      this.acking = null;
      this.emit();
    }
  }

  private filter(notices: readonly NoticeView[]): NoticeView[] {
    return noticeOrder(notices).filter(notice => !this.ended.has(notice.notice_id.toLowerCase()));
  }
  private make(): NoticeBoardSnapshot {
    return Object.freeze({ notices: Object.freeze(this.filter(this.list)), read: this.readState, required: this.required,
      acking: this.acking });
  }
  private emit(): void {
    this.snapshot = this.make();
    for (const listener of [...this.listeners]) listener();
  }
}

/** The board of one opened document; it follows each new access of the document (a foreground answers a new one). */
export function useNoticeBoard(options: { access: OpenedAccess; transport: HttpOptions; newId(): string }) {
  const [board] = useState(() => new NoticeBoard({ api: createNoticeApi(options.transport), newId: options.newId,
    access: options.access }));
  const snapshot = useSyncExternalStore(board.subscribe, board.getSnapshot, board.getSnapshot);
  useLayoutEffect(() => { board.observe(options.access); }, [board, options.access]);
  // Until the layout effect took a new access, its own list is read directly: no frame shows an older one.
  const notices = board.hasSeen(options.access) ? snapshot.notices : board.pendingOf(options.access);
  return { board, snapshot, notices };
}
