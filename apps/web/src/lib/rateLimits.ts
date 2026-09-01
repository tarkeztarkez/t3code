import type { OrchestrationThreadActivity, ProviderKind } from "@t3tools/contracts";

type UnknownRecord = Record<string, unknown>;

export interface UsageLimitWindow {
  readonly id: string;
  readonly label: string;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly resetsAt: number | null;
  readonly status: string | null;
  readonly updatedAt: string;
}

export interface UsageLimitsSnapshot {
  readonly provider: ProviderKind;
  readonly windows: ReadonlyArray<UsageLimitWindow>;
  readonly updatedAt: string;
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function percentage(value: unknown, ratio = false): number | null {
  const number = asFiniteNumber(value);
  if (number === null) return null;
  return Math.max(0, Math.min(100, ratio && number <= 1 ? number * 100 : number));
}

function resetTimestamp(value: unknown): number | null {
  const number = asFiniteNumber(value);
  if (number === null || number <= 0) return null;
  const timestamp = number < 10_000_000_000 ? number * 1_000 : number;
  return timestamp <= 8_640_000_000_000_000 ? timestamp : null;
}

function durationLabel(minutes: number | null, fallback: string): string {
  if (minutes === null) return fallback;
  if (minutes % 10_080 === 0) return `${minutes / 10_080}w`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function codexWindows(value: unknown, updatedAt: string): UsageLimitWindow[] {
  const envelope = asRecord(value);
  const snapshot = asRecord(envelope?.rateLimits) ?? envelope;
  if (!snapshot) return [];

  return (["primary", "secondary"] as const).flatMap((key) => {
    const window = asRecord(snapshot[key]);
    if (!window) return [];
    const usedPercentage = percentage(window.usedPercent);
    const minutes = asFiniteNumber(window.windowDurationMins);
    return [
      {
        id: key,
        label: durationLabel(minutes, key === "primary" ? "Primary" : "Secondary"),
        usedPercentage,
        remainingPercentage: usedPercentage === null ? null : 100 - usedPercentage,
        resetsAt: resetTimestamp(window.resetsAt),
        status: null,
        updatedAt,
      },
    ];
  });
}

const CLAUDE_LIMIT_LABELS: Record<string, string> = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_opus: "Opus 7d",
  seven_day_sonnet: "Sonnet 7d",
  overage: "Overage",
};

function claudeWindows(value: unknown, updatedAt: string): UsageLimitWindow[] {
  const envelope = asRecord(value);
  const info = asRecord(envelope?.rate_limit_info) ?? envelope;
  if (!info) return [];
  const id = asString(info.rateLimitType);
  if (!id) return [];
  const usedPercentage = percentage(info.utilization, true);
  return [
    {
      id,
      label: CLAUDE_LIMIT_LABELS[id] ?? id.replaceAll("_", " "),
      usedPercentage,
      remainingPercentage: usedPercentage === null ? null : 100 - usedPercentage,
      resetsAt: resetTimestamp(info.resetsAt),
      status: asString(info.status),
      updatedAt,
    },
  ];
}

export function deriveLatestUsageLimits(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  provider: ProviderKind,
): UsageLimitsSnapshot | null {
  const windows = new Map<string, UsageLimitWindow>();
  let updatedAt: string | null = null;

  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "account-rate-limits.updated") continue;
    const payload = asRecord(activity.payload);
    if (payload?.provider !== provider) continue;
    updatedAt ??= activity.createdAt;
    const parsed =
      provider === "claudeAgent"
        ? claudeWindows(payload.rateLimits, activity.createdAt)
        : provider === "codex" || provider === "pi"
          ? codexWindows(payload.rateLimits, activity.createdAt)
          : [];
    for (const window of parsed) {
      if (!windows.has(window.id)) windows.set(window.id, window);
    }
  }

  return updatedAt && windows.size > 0
    ? { provider, windows: [...windows.values()], updatedAt }
    : null;
}
