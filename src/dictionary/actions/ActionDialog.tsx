import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";

type Props = {
  title: string;
  /** The element focused on open; focus returns to the opener on close. */
  initialFocus: RefObject<HTMLElement | null>;
  onClose(): void;
  children: ReactNode;
};

/**
 * A window of RA table 6.1.12 over the card: role=dialog with its title, focus inside, Escape closes as native Back does
 * (overlay layer, useCardActions).
 */
export function ActionDialog({ title, initialFocus, onClose, children }: Props) {
  const id = useId();
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    initialFocus.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [initialFocus]);
  return <div className="card-dialog-backdrop">
    <div className="card-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); close.current(); } }}>
      <h2 id={`${id}-title`}>{title}</h2>
      {children}
    </div>
  </div>;
}
