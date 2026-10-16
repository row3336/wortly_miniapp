/**
 * Labels of the command state controls, the same in every study screen: check by the same ID, resend, retry Stop.
 * updateDevice: the outcome is confirmed, only the local record could not be cleared; the control repeats that cleanup
 * and checks nothing (not the manual check CT §6.1 п. 2 forbids).
 * retryStop (the Q30 button): wording approved by the owner (R10, 08.10.2026); display conditions follow TA.
 * updateDevice: wording approved by the owner (S07, 08.10.2026); display conditions follow TA.
 * check and retry: working text, pending owner approval.
 */
export const commandCopy = {
  ru: { check: "Проверить состояние", retry: "Повторить отправку", retryStop: "Повторить завершение", updateDevice: "Продолжить" },
  uk: { check: "Перевірити стан", retry: "Повторити надсилання", retryStop: "Повторити завершення", updateDevice: "Продовжити" },
  en: { check: "Check status", retry: "Retry sending", retryStop: "Retry ending the session", updateDevice: "Continue" },
} as const;

/**
 * The status of the automatic recovery of a study action (Я15.2: a blurred screen, an indicator and a clear connection
 * status; no buttons). checking, offline, resending, maintenance, conflict (table 9.2.1–9.2.5):
 * wording approved by the owner (R10, 08.10.2026); display conditions follow TA.
 * unsaved: a working interim text for the exhausted budget until the automatic closure of CP4; it is NOT the text
 * of 9.2.7 and stays pending owner approval (4.6-В8).
 * conflict: the same command_id carries another payload (Я17, CT §6.1 п. 10); its action is the screen's own «Выйти».
 * lost (Q27, C458): the answer's text is gone from this device and the server does not hold its ID — it is never sent
 * again; its action is the screen's own «Выйти». WORKING TEXT, pending owner approval.
 */
export const recoveryCopy = {
  ru: { checking: "Проверяем, сохранилось ли действие…", offline: "Нет связи с сервером. Ждём, когда связь восстановится…",
    resending: "Отправляем действие повторно…", maintenance: "Идёт плановое обновление. Подожди, мы продолжим сами.",
    unsaved: "Не удалось сохранить последнее действие. Связь восстановлена.",
    unconfirmed: "Не удалось подтвердить последнее действие. Мы продолжаем проверять. Можно завершить занятие.",
    endSession: "Завершить занятие",
    conflict: "Не удалось подтвердить это действие. Повторить его нельзя. Заверши занятие, чтобы продолжить.",
    lost: "Последний ответ не сохранился на этом устройстве и не дошёл до сервера. Повторить его нельзя. Заверши занятие, чтобы продолжить." },
  uk: { checking: "Перевіряємо, чи збереглася дія…", offline: "Немає зв’язку з сервером. Чекаємо на відновлення зв’язку…",
    resending: "Надсилаємо дію повторно…", maintenance: "Триває планове оновлення. Зачекай, ми продовжимо самі.",
    unsaved: "Не вдалося зберегти останню дію. Зв’язок відновлено.",
    unconfirmed: "Не вдалося підтвердити останню дію. Ми продовжуємо перевіряти. Можна завершити заняття.",
    endSession: "Завершити заняття",
    conflict: "Не вдалося підтвердити цю дію. Повторити її не можна. Заверши заняття, щоб продовжити.",
    lost: "Остання відповідь не збереглася на цьому пристрої й не дійшла до сервера. Повторити її не можна. Заверши заняття, щоб продовжити." },
  en: { checking: "Checking whether your action was saved…", offline: "No connection to the server. Waiting for the connection to come back…",
    resending: "Sending your action again…", maintenance: "A planned update is in progress. Please wait, we'll continue automatically.",
    unsaved: "We couldn't save your last action. The connection is back.",
    unconfirmed: "We couldn't confirm your last action. We keep checking. You can end the session.",
    endSession: "End session",
    conflict: "We couldn't confirm this action. It can't be repeated. End the session to continue.",
    lost: "Your last answer wasn't saved on this device and didn't reach the server. It can't be repeated. End the session to continue." },
} as const;

/**
 * PAUSED_BEFORE_SEND of a manual action (P03 §4.8 «Ручные K01s, K03–K14», M-P03-8): the write gate kept the request on
 * the client. Until M-P03-9 sets the texts of §4.8 by cause, it reuses the approved 9.2.2 line of the recovery status
 * (no new wording; the cause-specific 9.2.4 with the estimate comes with M-P03-9).
 */
export const pausedCopy = {
  ru: recoveryCopy.ru.offline,
  uk: recoveryCopy.uk.offline,
  en: recoveryCopy.en.offline,
} as const;
