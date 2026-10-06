import { iconLabel, type IconName } from "../i18n/messages";
import type { Language } from "../i18n/language";

/** The working И1 sprite; final icons are G05. Resolved from the build base: the app need not live at the domain root. */
export const iconSprite = `${import.meta.env.BASE_URL}icons/i1-symbols.svg`;

type Props = { name: IconName; className?: string } & ({ language: Language; decorative?: false } | { decorative: true });

/**
 * One И1 symbol. An icon that is the only content of a control carries its name for the screen reader (TA §2);
 * an icon beside a visible text is decorative and hidden from it, so the name is not read twice.
 */
export function Icon(props: Props) {
  const name = props.decorative ? undefined : iconLabel(props.language, props.name);
  return <svg className={props.className ?? "nav-icon"} viewBox="0 0 24 24" focusable="false"
    {...(name === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": name })}>
    <use href={`${iconSprite}#${props.name}`} />
  </svg>;
}
