import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { deriveLatestUsageLimits } from "./rateLimits";

function activity(id: string, provider: "codex" | "claudeAgent" | "pi", rateLimits: unknown) {
  return {
    id: EventId.make(id),
    tone: "info",
    kind: "account-rate-limits.updated",
    summary: "Usage limits updated",
    payload: { provider, rateLimits },
    turnId: null,
    createdAt: `2026-04-16T10:00:0${id}.000Z`,
  } satisfies OrchestrationThreadActivity;
}

describe("deriveLatestUsageLimits", () => {
  it("reads Codex quota windows and reports the percentage remaining", () => {
    const result = deriveLatestUsageLimits(
      [
        activity("1", "codex", {
          rateLimits: {
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
            secondary: { usedPercent: 60, windowDurationMins: 10_080 },
          },
        }),
      ],
      "codex",
    );

    expect(result?.windows).toMatchObject([
      { id: "primary", label: "5h", usedPercentage: 25, remainingPercentage: 75 },
      { id: "secondary", label: "1w", usedPercentage: 60, remainingPercentage: 40 },
    ]);
    expect(result?.windows[0]?.resetsAt).toBe(1_800_000_000_000);
  });

  it("keeps the newest event for each Claude limit window", () => {
    const result = deriveLatestUsageLimits(
      [
        activity("1", "claudeAgent", {
          type: "rate_limit_event",
          rate_limit_info: { rateLimitType: "seven_day", utilization: 0.4 },
        }),
        activity("2", "claudeAgent", {
          type: "rate_limit_event",
          rate_limit_info: {
            rateLimitType: "five_hour",
            utilization: 0.75,
            status: "allowed_warning",
          },
        }),
      ],
      "claudeAgent",
    );

    expect(result?.windows).toMatchObject([
      { id: "five_hour", label: "5h", remainingPercentage: 25, status: "allowed_warning" },
      { id: "seven_day", label: "7d", remainingPercentage: 60 },
    ]);
  });

  it("reads Codex response limits forwarded by Pi", () => {
    const result = deriveLatestUsageLimits(
      [
        activity("1", "pi", {
          rateLimits: {
            primary: { usedPercent: 10, windowDurationMins: 300 },
          },
        }),
      ],
      "pi",
    );

    expect(result?.windows[0]).toMatchObject({ label: "5h", remainingPercentage: 90 });
  });
});
