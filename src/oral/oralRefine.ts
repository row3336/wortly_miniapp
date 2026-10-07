import type { OralDocumentSnapshot } from "./oralDocumentController";

/**
 * The card of the oral question that may open as М12 («Уточнить поля» and the card actions), or null.
 * root decision, pending owner (M-ORAL-ENTRY Р1, Q25): RA:220 allows it until the self-assessment, so both the hidden
 * and the revealed question qualify; TA:132 and К05-088 name only the revealed one. The owner's rights decide, so an
 * unresolved command of either lane or a prefetched question keeps the card closed (Р2).
 */
export function oralRefineCardId(state: OralDocumentSnapshot | null): string | null {
  const assignment = state?.current?.status === "active" ? state.current.assignment : null;
  if (!state || !assignment || assignment.status !== "presented") return null;
  return state.canReveal || state.canGrade ? assignment.card_id : null;
}
