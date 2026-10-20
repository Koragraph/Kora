import { HealthCheckSection } from "./HealthCheckSection";
import { PrefsPageContainer } from "./prefsLayout";
import { usePrefsScope } from "./PrefsScopeContext";

export function DiagnosticsPrefsPanel() {
  const { environment } = usePrefsScope();
  return (
    <PrefsPageContainer className="gap-10">
      <HealthCheckSection hostId={environment?.hostId ?? null} />
    </PrefsPageContainer>
  );
}
