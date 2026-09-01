import type { UsageLimitsSnapshot } from "~/lib/rateLimits";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

function formatPercentage(value: number | null): string {
  return value === null ? "Unknown" : `${Math.round(value)}%`;
}

function formatReset(value: number | null): string | null {
  if (value === null) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

export function UsageLimitsMeter(props: { usage: UsageLimitsSnapshot }) {
  const primary = props.usage.windows[0];
  if (!primary) return null;
  const providerLabel =
    props.usage.provider === "codex" ? "Codex" : props.usage.provider === "pi" ? "Pi" : "Claude";

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={`${providerLabel} ${primary.label} limit, ${formatPercentage(primary.remainingPercentage)} remaining`}
          >
            <span>{primary.label}</span>
            <span>{formatPercentage(primary.remainingPercentage)}</span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-64 px-3 py-2.5">
        <div className="space-y-2.5">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {providerLabel} usage limits
          </div>
          <div className="space-y-2">
            {props.usage.windows.map((window) => {
              const reset = formatReset(window.resetsAt);
              return (
                <div key={window.id} className="space-y-1">
                  <div className="flex items-center justify-between gap-4 text-xs">
                    <span className="font-medium text-foreground">{window.label}</span>
                    <span className="tabular-nums text-foreground">
                      {formatPercentage(window.remainingPercentage)} remaining
                    </span>
                  </div>
                  {window.usedPercentage !== null ? (
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-muted-foreground transition-[width] duration-500 motion-reduce:transition-none"
                        style={{ width: `${window.usedPercentage}%` }}
                      />
                    </div>
                  ) : null}
                  <div className="flex justify-between gap-3 text-[10px] text-muted-foreground">
                    {window.status ? <span>{window.status.replaceAll("_", " ")}</span> : <span />}
                    {reset ? <span>Resets {reset}</span> : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
