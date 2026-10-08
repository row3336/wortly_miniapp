/**
 * The card a bot button asks the Mini App to open at launch (answer Q20, variant A): the bot opens the configured
 * address with `?card=<id>`. The id is a reference only and grants nothing: the entry signs in with initData as
 * always, and the core answers the card read by the user's own rights (a hidden card is unavailable to others, Q23).
 *
 * It is read from the query, never from the fragment: Telegram puts its launch data (tgWebAppData) there. Anything
 * but a UUID is ignored, so the parameter cannot address another route or carry text into a request.
 */
const parameter = "card";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function launchCardId(search: string): string | null {
  const values = new URLSearchParams(search).getAll(parameter);
  // Two values name no single card; neither is guessed.
  if (values.length !== 1 || !uuid.test(values[0])) return null;
  return values[0].toLowerCase();
}

/**
 * The address without the card parameter; every other part is kept as written (no re-encoding), the fragment too, since
 * Telegram's launch data lives there.
 */
export function withoutLaunchCard(search: string): string {
  const parts = search.replace(/^\?/, "").split("&").filter(part => {
    if (!part) return false;
    try {
      return decodeURIComponent(part.split("=")[0].replaceAll("+", " ")) !== parameter;
    } catch {
      return true;
    }
  });
  return parts.length ? `?${parts.join("&")}` : "";
}

/**
 * One request per launch: the first document that starts takes it, a later document (a reopen) never sees it.
 * Once the card was shown and closed, `viewed` forgets it in the address too (answer S03): a reload of this same address
 * then opens the application without it. A new tap of the bot button opens a new address with the card again.
 */
export class LaunchCard {
  constructor(private cardId: string | null, private forget: () => void = () => {}) {}

  take(): string | null {
    const cardId = this.cardId;
    this.cardId = null;
    return cardId;
  }

  viewed(): void {
    const forget = this.forget;
    this.forget = () => {};
    forget();
  }
}

/** Replaces the address in place, without a new history entry or a reload; a window that refuses keeps its address. */
export function forgetLaunchCard(win: Window): void {
  try {
    const { pathname, search, hash } = win.location;
    const next = withoutLaunchCard(search);
    if (next !== search) win.history.replaceState(win.history.state, "", `${pathname}${next}${hash}`);
  } catch { /* The card then opens again on a reload; nothing else depends on the address. */ }
}
