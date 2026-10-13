import type { FeedbackProblem } from "../../feedback/feedbackController";
import type { Language } from "../../i18n/language";

type Copy = {
  group: string; exclude: string; restore: string; relearn: string; report: string;
  saving: string; checking: string; unknown: string; retry: string;
  refused: string; conflict: string; setup: string; mismatch: string;
  relearnTitle(lemma: string): string; relearnText: string; relearnConfirm: string; cancel: string;
  reportTitle: string; reportLabel: string; reportAttached(lemma: string): string; send: string; close: string;
  sending: string; reportChecking: string; reportRefused: string; reportSent: string; reportRetry: string;
  reportProblems: Record<FeedbackProblem, string>;
  reportCounter(length: number, max: number): string; reportTooLong(over: number): string; reportRefusedInvalid: string;
};

// root decision, pending owner (M-ACTIONS Р10): working copy for G05. The button labels are RA tables 6.1.10–6.1.12
// («Не повторять», «Вернуть в повторы», «Изучить заново», «Сообщить об ошибке», field «Что не так?», «Отправить»);
// the explanations and the uk/en texts are working translations. R7-01 (К19-042, П5-022): the counter, the over-limit warning
// and the 422 VALIDATION_FAILED text are working ru/uk/en texts too.
export const actionsCopy: Record<Language, Copy> = {
  ru: {
    group: "Действия с карточкой", exclude: "Не повторять", restore: "Вернуть в повторы", relearn: "Изучить заново",
    report: "Сообщить об ошибке", saving: "Сохраняем…", checking: "Проверяем, сохранилось ли действие…",
    unknown: "Нет подтверждения, что действие сохранено.", retry: "Повторить",
    refused: "Не удалось сохранить действие.", conflict: "Карточка уже изменилась. Показано актуальное состояние.",
    setup: "Сначала нужно подтвердить часовой пояс в настройках.", mismatch: "Это действие нельзя повторить. Проверь состояние карточки.",
    relearnTitle: lemma => `Изучить заново «${lemma}»?`,
    relearnText: "Основные письменные повторы (перевод → немецкий) начнутся с нуля. История ответов сохранится, устное направление не изменится.",
    relearnConfirm: "Изучить заново", cancel: "Отмена",
    reportTitle: "Сообщить об ошибке", reportLabel: "Что не так?", reportAttached: lemma => `Карточка «${lemma}» будет приложена.`,
    send: "Отправить", close: "Закрыть", sending: "Отправляем…", reportChecking: "Проверяем, принято ли сообщение…",
    reportRefused: "Сообщение не принято. Текст сохранён: проверь его и отправь снова.", reportSent: "Сообщение отправлено.",
    reportRetry: "Повторить отправку",
    reportCounter: (length, max) => `${length} из ${max}`,
    reportTooLong: over => `Текст слишком длинный: лишних знаков ${over}. Текст сохранён — сократи его, и сообщение можно будет отправить. Эмодзи считается за 2 знака.`,
    reportRefusedInvalid: "Сообщение не принято: текст не подходит (слишком длинный или с недопустимыми символами). Текст сохранён: сократи или исправь его и отправь снова.",
    reportProblems: {
      network: "Пока не удалось подтвердить, что сообщение принято. Текст сохранён. Повтори отправку.",
      not_sent: "Сообщение ещё не принято. Текст сохранён. Повтори отправку.",
      storage: "Не удалось обновить временную запись отправки. Повтори отправку.",
      invalid_pending: "Запись отправки повреждена, отправить сообщение сейчас нельзя.",
      pending_changed: "Запись отправки изменилась. Закрой окно и открой карточку заново.",
      expired: "Сеанс истёк. Текст сохранён: открой приложение заново.",
      forbidden: "Нет доступа к отправке сообщений. Текст сохранён.",
    },
  },
  uk: {
    group: "Дії з карткою", exclude: "Не повторювати", restore: "Повернути в повторення", relearn: "Вивчити знову",
    report: "Повідомити про помилку", saving: "Зберігаємо…", checking: "Перевіряємо, чи збереглася дія…",
    unknown: "Немає підтвердження, що дію збережено.", retry: "Повторити",
    refused: "Не вдалося зберегти дію.", conflict: "Картка вже змінилася. Показано актуальний стан.",
    setup: "Спочатку потрібно підтвердити часовий пояс у налаштуваннях.", mismatch: "Цю дію не можна повторити. Перевір стан картки.",
    relearnTitle: lemma => `Вивчити знову «${lemma}»?`,
    relearnText: "Основні письмові повторення (переклад → німецька) почнуться з нуля. Історія відповідей збережеться, усний напрям не зміниться.",
    relearnConfirm: "Вивчити знову", cancel: "Скасувати",
    reportTitle: "Повідомити про помилку", reportLabel: "Що не так?", reportAttached: lemma => `Картку «${lemma}» буде додано.`,
    send: "Надіслати", close: "Закрити", sending: "Надсилаємо…", reportChecking: "Перевіряємо, чи прийнято повідомлення…",
    reportRefused: "Повідомлення не прийнято. Текст збережено: перевір його й надішли знову.", reportSent: "Повідомлення надіслано.",
    reportRetry: "Повторити надсилання",
    reportCounter: (length, max) => `${length} з ${max}`,
    reportTooLong: over => `Текст задовгий: зайвих знаків ${over}. Текст збережено — скороти його, і повідомлення можна буде надіслати. Емодзі рахується за 2 знаки.`,
    reportRefusedInvalid: "Повідомлення не прийнято: текст не підходить (задовгий або з недопустимими символами). Текст збережено: скороти або виправ його й надішли знову.",
    reportProblems: {
      network: "Поки не вдалося підтвердити, що повідомлення прийнято. Текст збережено. Повтори надсилання.",
      not_sent: "Повідомлення ще не прийнято. Текст збережено. Повтори надсилання.",
      storage: "Не вдалося оновити тимчасовий запис надсилання. Повтори надсилання.",
      invalid_pending: "Запис надсилання пошкоджено, надіслати повідомлення зараз неможливо.",
      pending_changed: "Запис надсилання змінився. Закрий вікно й відкрий картку знову.",
      expired: "Сеанс завершився. Текст збережено: відкрий застосунок знову.",
      forbidden: "Немає доступу до надсилання повідомлень. Текст збережено.",
    },
  },
  en: {
    group: "Card actions", exclude: "Don't review", restore: "Back to reviews", relearn: "Learn again",
    report: "Report a mistake", saving: "Saving…", checking: "Checking whether the action was saved…",
    unknown: "The action is not confirmed yet.", retry: "Retry",
    refused: "Could not save the action.", conflict: "The card has already changed. The current state is shown.",
    setup: "Confirm your time zone in Settings first.", mismatch: "This action cannot be retried. Check the card.",
    relearnTitle: lemma => `Learn “${lemma}” again?`,
    relearnText: "Main written reviews (translation → German) start from scratch. Your answer history is kept; the oral direction does not change.",
    relearnConfirm: "Learn again", cancel: "Cancel",
    reportTitle: "Report a mistake", reportLabel: "What is wrong?", reportAttached: lemma => `The card “${lemma}” is attached.`,
    send: "Send", close: "Close", sending: "Sending…", reportChecking: "Checking whether the message was accepted…",
    reportRefused: "The message was not accepted. The text is kept: check it and send again.", reportSent: "Message sent.",
    reportRetry: "Retry sending",
    reportCounter: (length, max) => `${length} of ${max}`,
    reportTooLong: over => `The text is too long by ${over} characters. The text is kept: shorten it and the message can be sent. An emoji counts as 2.`,
    reportRefusedInvalid: "The message was not accepted: the text does not fit (too long or with invalid characters). The text is kept: shorten or fix it and send again.",
    reportProblems: {
      network: "Could not confirm yet that the message was accepted. The text is kept. Retry sending.",
      not_sent: "The message has not been accepted yet. The text is kept. Retry sending.",
      storage: "Could not update the temporary record of the message. Retry sending.",
      invalid_pending: "The message record is damaged, so a message cannot be sent now.",
      pending_changed: "The message record changed. Close the window and open the card again.",
      expired: "The session expired. The text is kept: reopen the app.",
      forbidden: "No access to sending messages. The text is kept.",
    },
  },
};
