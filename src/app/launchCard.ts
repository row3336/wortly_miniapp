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

/** One request per launch: the first document that starts takes it, a later document (a reopen) never sees it. */
export class LaunchCard {
  constructor(private cardId: string | null) {}

  take(): string | null {
    const cardId = this.cardId;
    this.cardId = null;
    return cardId;
  }
}
