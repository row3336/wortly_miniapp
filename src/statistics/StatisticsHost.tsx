import { useState } from "react";
import type { HttpOptions } from "../api/http";
import type { OpenedAccess } from "../app/openedAccess";
import type { Language } from "../i18n/language";
import type { PracticeWeek } from "./practiceApi";
import { StatisticsScreen } from "./StatisticsScreen";
import { useStatisticsDocument } from "./useStatisticsDocument";

type Props = {
  access: OpenedAccess; transport: HttpOptions; language: Language;
  /** The highest settings/profile version the application has observed; an older read is refused. */
  minimumStateVersion?: string;
  onBack(): void;
};

/**
 * One visit of the statistics screen. Mounting reads the server; a return to the foreground is a fresh access that the
 * document hook reads again (TA:362). The week is local to the visit: every entry starts with the current one.
 */
export function StatisticsHost(props: Props) {
  const [week, setWeek] = useState<PracticeWeek>("current");
  const { state, refresh } = useStatisticsDocument({ access: props.access, transport: props.transport, week, enabled: true,
    minimumStateVersion: props.minimumStateVersion });
  return <StatisticsScreen state={state} week={week} language={props.language} onWeek={setWeek}
    onRetry={() => { void refresh(); }} onBack={props.onBack} />;
}
