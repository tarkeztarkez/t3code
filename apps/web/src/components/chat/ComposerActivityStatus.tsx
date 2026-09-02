import { LoaderCircleIcon } from "lucide-react";
import { threadSyncLabel, type ThreadSyncPhase } from "../../threadSync";
import { ComposerBanner } from "./ComposerBanner";

export function ComposerActivityRow({
  phase,
  agentWorking,
}: {
  readonly phase: ThreadSyncPhase;
  readonly agentWorking: boolean;
}) {
  return (
    <ComposerBanner.Row>
      <ComposerBanner.Icon>
        <LoaderCircleIcon className="motion-safe:animate-spin" />
      </ComposerBanner.Icon>
      <ComposerBanner.Content>
        <span
          className="shrink-0 whitespace-nowrap text-muted-foreground"
          data-composer-sync-status={phase}
          role="status"
        >
          {threadSyncLabel(phase, agentWorking)}
        </span>
      </ComposerBanner.Content>
    </ComposerBanner.Row>
  );
}
