import type { Language } from "../i18n/language";

/**
 * Texts of the profile deletion (P04 ред.14 §8; TZA:313, S-A07). `deleted` is the TZA:313 draft shown to the owner
 * (no «полностью»/«fully» until the archive is processed, И15). Every other line is a WORKING TEXT of DEV-16 (not in
 * TZA, §13.2 п.8): the owner's explanation, the question, the unknown outcome (PD-28) and the refusals — to be shown to
 * the owner before the acceptance of the screen.
 */
export const profileDeleteCopy = {
  ru: {
    group: "Удаление профиля",
    open: "Удалить профиль",
    // WORKING TEXT (Q-DEL-1)
    ownerNote: "Владелец не может удалить свой профиль в приложении. Удаление владельца выполняется отдельно, вручную.",
    // WORKING TEXT
    question: "Удалить профиль? Будут удалены твои переводы, примеры, прогресс, история и настройки. Отменить это нельзя.",
    wait: (seconds: number) => `Кнопка станет доступна через ${seconds} с.`,
    confirm: "Удалить навсегда",
    cancel: "Отмена",
    sending: "Удаляем профиль…",
    repeating: "Ответ не получен. Проверяем удаление тем же запросом…",
    paused: "Сейчас приложение не может отправить запрос. Попробуй ещё раз, когда кнопка станет доступна.",
    refused: "Профиль не удалён. Сервер отклонил запрос.",
    refusedIncompatible: "Профиль не удалён: нужно обновить приложение. Закрой Wortly и открой его снова через бота.",
    notDeleted: "Профиль не удалён. Чтобы удалить его, начни заново.",
    stuck: "Ответ на удаление так и не получен. Проверь результат.",
    check: "Проверить",
    // WORKING TEXT (C375: the intent of an unknown outcome was dropped on this screen)
    dropped: "Удаление прервано, его исход неизвестен. Чтобы удалить профиль, начни заново.",
    deleted: "Профиль удалён из приложения. Архивные копии ещё обрабатываются — до 7 дней.",
    // WORKING TEXT (PD-28)
    unknownTitle: "Исход удаления неизвестен",
    unknownDetail: "Мы не знаем, удалён ли профиль: вход закончился до ответа. Войди снова — тогда станет ясно.",
    login: "Войти",
    // WORKING TEXT (PD-28 after the explicit sign-in)
    deletedAfterLogin: "Прежний профиль удалён из приложения.",
    notDeletedAfterLogin: "Профиль не был удалён. Чтобы удалить его, начни заново в настройках.",
    continue: "Продолжить",
  },
  uk: {
    group: "Видалення профілю",
    open: "Видалити профіль",
    ownerNote: "Власник не може видалити свій профіль у застосунку. Видалення власника виконується окремо, вручну.",
    question: "Видалити профіль? Буде видалено твої переклади, приклади, прогрес, історію та налаштування. Скасувати це неможливо.",
    wait: (seconds: number) => `Кнопка стане доступна через ${seconds} с.`,
    confirm: "Видалити назавжди",
    cancel: "Скасувати",
    sending: "Видаляємо профіль…",
    repeating: "Відповідь не отримано. Перевіряємо видалення тим самим запитом…",
    paused: "Зараз застосунок не може надіслати запит. Спробуй ще раз, коли кнопка стане доступна.",
    refused: "Профіль не видалено. Сервер відхилив запит.",
    refusedIncompatible: "Профіль не видалено: потрібно оновити застосунок. Закрий Wortly і відкрий його знову через бота.",
    notDeleted: "Профіль не видалено. Щоб видалити його, почни спочатку.",
    stuck: "Відповідь на видалення так і не отримано. Перевір результат.",
    check: "Перевірити",
    dropped: "Видалення перервано, його результат невідомий. Щоб видалити профіль, почни спочатку.",
    deleted: "Профіль видалено із застосунку. Архівні копії ще обробляються — до 7 днів.",
    unknownTitle: "Результат видалення невідомий",
    unknownDetail: "Ми не знаємо, чи видалено профіль: вхід завершився до відповіді. Увійди знову — тоді стане зрозуміло.",
    login: "Увійти",
    deletedAfterLogin: "Попередній профіль видалено із застосунку.",
    notDeletedAfterLogin: "Профіль не було видалено. Щоб видалити його, почни спочатку в налаштуваннях.",
    continue: "Продовжити",
  },
  en: {
    group: "Delete profile",
    open: "Delete profile",
    ownerNote: "The owner cannot delete their own profile in the app. An owner is deleted separately, by hand.",
    question: "Delete your profile? Your translations, examples, progress, history and settings will be deleted. This cannot be undone.",
    wait: (seconds: number) => `The button becomes available in ${seconds} s.`,
    confirm: "Delete for good",
    cancel: "Cancel",
    sending: "Deleting your profile…",
    repeating: "No answer yet. Checking the deletion with the same request…",
    paused: "The app cannot send the request right now. Try again once the button is available.",
    refused: "Your profile was not deleted. The server refused the request.",
    refusedIncompatible: "Your profile was not deleted: the app needs an update. Close Wortly and open it again from the bot.",
    notDeleted: "Your profile was not deleted. To delete it, start again.",
    stuck: "No answer to the deletion arrived. Check the result.",
    check: "Check",
    dropped: "The deletion was interrupted and its outcome is unknown. To delete your profile, start again.",
    deleted: "Your profile has been removed from the app. Archive copies are still being processed, for up to 7 days.",
    unknownTitle: "Deletion outcome unknown",
    unknownDetail: "We do not know whether your profile was deleted: the sign-in ended before the answer. Sign in again to find out.",
    login: "Sign in",
    deletedAfterLogin: "Your previous profile has been removed from the app.",
    notDeletedAfterLogin: "Your profile was not deleted. To delete it, start again in the settings.",
    continue: "Continue",
  },
} as const satisfies Record<Language, unknown>;

export function deleteText(language: Language) { return profileDeleteCopy[language]; }
