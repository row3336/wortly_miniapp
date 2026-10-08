import { useEffect, useRef } from "react";
import type { Language } from "../i18n/language";
import type { EntryState } from "../app/entryState";

// Wording approved by the owner (R10, 08.10.2026); display conditions follow TA. Covers changedDetail (ru/uk/en),
// the "End session" / "Cancel" buttons and the "Please wait" line; the ru text was already approved earlier (В4, TA §12.1).
const copy = {
  ru: {
    busy: "Занятие на другом устройстве", busyDetail: "Ты можешь завершить его здесь. Учебный прогресс сохранится.",
    progress: "Здесь доступен общий прогресс. Продолжить занятие можно на другом устройстве.", refresh: "Обновить прогресс",
    request: "Завершить занятие на другом устройстве", confirm: "Завершить занятие?",
    confirmDetail: "На другом устройстве это занятие закончится. Сохранённый учебный прогресс останется.",
    yes: "Завершить занятие", cancel: "Отмена", checking: "Проверяем завершение занятия",
    sending: "Завершаем занятие", wait: "Подожди немного.", unknown: "Завершение пока не подтверждено",
    unknownDetail: "Пока неизвестно, завершилось ли занятие. Проверь результат перед продолжением.",
    storageDetail: "Не удалось сохранить состояние запроса на устройстве. Попробуй проверить ещё раз.",
    accepted: "Занятие завершено", rejected: "Запрос не принят", check: "Проверить результат",
    retry: "Повторить завершение", mismatch: "Не удалось подтвердить этот запрос. Повторная отправка недоступна.",
    changedDetail: "На другом устройстве теперь идёт другое занятие. Завершить это занятие?",
  },
  uk: {
    busy: "Заняття на іншому пристрої", busyDetail: "Ти можеш завершити його тут. Навчальний прогрес збережеться.",
    progress: "Тут доступний загальний прогрес. Продовжити заняття можна на іншому пристрої.", refresh: "Оновити прогрес",
    request: "Завершити заняття на іншому пристрої", confirm: "Завершити заняття?",
    confirmDetail: "На іншому пристрої це заняття закінчиться. Збережений навчальний прогрес залишиться.",
    yes: "Завершити заняття", cancel: "Скасувати", checking: "Перевіряємо завершення заняття",
    sending: "Завершуємо заняття", wait: "Зачекай трохи.", unknown: "Завершення поки не підтверджено",
    unknownDetail: "Поки невідомо, чи завершилося заняття. Перевір результат перед продовженням.",
    storageDetail: "Не вдалося зберегти стан запиту на пристрої. Спробуй перевірити ще раз.",
    accepted: "Заняття завершено", rejected: "Запит не прийнято", check: "Перевірити результат",
    retry: "Повторити завершення", mismatch: "Не вдалося підтвердити цей запит. Повторне надсилання недоступне.",
    changedDetail: "На іншому пристрої тепер триває інше заняття. Завершити це заняття?",
  },
  en: {
    busy: "Session on another device", busyDetail: "You can end it here. Your learning progress will be saved.",
    progress: "You can view your overall progress here. Continue the session on the other device.", refresh: "Refresh progress",
    request: "End the session on the other device", confirm: "End the session?",
    confirmDetail: "This session will end on the other device. Your saved learning progress will remain.",
    yes: "End session", cancel: "Cancel", checking: "Checking whether the session ended",
    sending: "Ending the session", wait: "Please wait a moment.", unknown: "Session end is not confirmed yet",
    unknownDetail: "We do not know yet whether the session ended. Check the result before continuing.",
    storageDetail: "The request state could not be saved on this device. Try checking again.",
    accepted: "Session ended", rejected: "Request not accepted", check: "Check result",
    retry: "Retry ending the session", mismatch: "This request could not be confirmed. Resending is unavailable.",
    changedDetail: "A different session is now running on the other device. End this session?",
  },
} as const;

export function RemoteStopNotice({ language, onRequest, onRefresh }: {
  language: Language; onRequest(): void; onRefresh(): void;
}) {
  const text = copy[language];
  return <section className="today-card" aria-label={text.busy}>
    <h2>{text.busy}</h2><p>{text.progress}</p>
    <button type="button" className="secondary-action" onClick={onRefresh}>{text.refresh}</button>
    <button type="button" className="secondary-action" onClick={onRequest}>{text.request}</button>
  </section>;
}

type Props = {
  state: Extract<EntryState, { kind: "busy" | "remote_confirm" | "remote" }>;
  language: Language;
  onRequest?: () => void;
  onCancel?: () => void;
  onConfirm?: () => void;
  onCheck?: () => void;
  onRetry?: () => void;
};

export function RemoteStopScreen({ state, language, onRequest, onCancel, onConfirm, onCheck, onRetry }: Props) {
  const text = copy[language];
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (state.kind === "remote_confirm") cancel.current?.focus(); }, [state.kind]);
  const remote = state.kind === "remote" ? state.remote : null;
  const working = remote !== null && ["loading", "checking", "sending", "settled"].includes(remote.phase);
  const changed = state.kind === "remote_confirm" && state.changed === true;
  const title = state.kind === "busy" ? text.busy : state.kind === "remote_confirm" ? text.confirm
    : working ? remote?.phase === "sending" ? text.sending : text.checking
    : remote?.outcome === "accepted" ? text.accepted : remote?.outcome === "rejected" ? text.rejected : text.unknown;
  const detail = state.kind === "busy" ? text.busyDetail : changed ? text.changedDetail
    : state.kind === "remote_confirm" ? text.confirmDetail
    : working ? text.wait : remote?.outcome || remote?.problem === "storage" ? text.storageDetail
    : remote?.problem === "mismatch" ? text.mismatch : text.unknownDetail;
  return <main className="app-shell">
    <section className="entry-card" aria-live="polite" aria-busy={working}
      onKeyDown={event => { if (state.kind === "remote_confirm" && event.key === "Escape") onCancel?.(); }}>
      <h1>{title}</h1><p>{detail}</p>
      {state.kind === "busy" && state.remoteTarget && onRequest &&
        <button type="button" className="primary-action" onClick={onRequest}>{text.request}</button>}
      {state.kind === "remote_confirm" && <>
        {onConfirm && <button type="button" className="primary-action" onClick={onConfirm}>{text.yes}</button>}
        {onCancel && <button ref={cancel} type="button" className="secondary-action" onClick={onCancel}>{text.cancel}</button>}
      </>}
      {state.kind === "remote" && !working && <>
        {onCheck && <button type="button" className="primary-action" onClick={onCheck}>{text.check}</button>}
        {remote?.canRetry && onRetry &&
          <button type="button" className="secondary-action" onClick={onRetry}>{text.retry}</button>}
      </>}
    </section>
  </main>;
}
