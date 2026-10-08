/**
 * Labels of the command state controls, the same in every study screen: check by the same ID, resend, retry Stop.
 * updateDevice: the outcome is confirmed, only the local record could not be cleared; the control repeats that cleanup
 * and checks nothing (not the manual check CT §6.1 п. 2 forbids). Working text, pending owner approval.
 */
export const commandCopy = {
  ru: { check: "Проверить состояние", retry: "Повторить отправку", retryStop: "Повторить завершение", updateDevice: "Обновить данные на устройстве" },
  uk: { check: "Перевірити стан", retry: "Повторити надсилання", retryStop: "Повторити завершення", updateDevice: "Оновити дані на пристрої" },
  en: { check: "Check status", retry: "Retry sending", retryStop: "Retry ending the session", updateDevice: "Update data on this device" },
} as const;

/**
 * The status of the automatic recovery of a study action (Я15.2: a blurred screen, an indicator and a clear connection
 * status; no buttons). Working copy from D-RECOV RESULTS_VP table 9.2 (9.2.1–9.2.4); unsaved is a working text for
 * the exhausted budget until the automatic closure of CP4. root decision, pending owner (4.6-В8).
 * conflict: the same command_id carries another payload (Я17, CT §6.1 п. 10); its action is the screen's own «Выйти».
 * ru is the owner's text; uk and en follow table 9.2.5 — translation pending owner approval.
 */
export const recoveryCopy = {
  ru: { checking: "Проверяем, сохранилось ли действие…", offline: "Нет связи с сервером. Ждём, когда связь восстановится…",
    resending: "Отправляем действие повторно…", maintenance: "Идёт плановое обновление. Подожди, мы продолжим сами.",
    unsaved: "Не удалось сохранить последнее действие. Связь восстановлена.",
    conflict: "Не удалось подтвердить это действие. Повторить его нельзя. Заверши занятие, чтобы продолжить." },
  uk: { checking: "Перевіряємо, чи збереглася дія…", offline: "Немає зв’язку з сервером. Чекаємо на відновлення зв’язку…",
    resending: "Надсилаємо дію повторно…", maintenance: "Триває планове оновлення. Зачекай, ми продовжимо самі.",
    unsaved: "Не вдалося зберегти останню дію. Зв’язок відновлено.",
    conflict: "Не вдалося підтвердити цю дію. Повторити її не можна. Заверши заняття, щоб продовжити." },
  en: { checking: "Checking whether your action was saved…", offline: "No connection to the server. Waiting for the connection to come back…",
    resending: "Sending your action again…", maintenance: "A planned update is in progress. Please wait, we'll continue automatically.",
    unsaved: "We couldn't save your last action. The connection is back.",
    conflict: "We couldn't confirm this action. It can't be repeated. End the session to continue." },
} as const;
