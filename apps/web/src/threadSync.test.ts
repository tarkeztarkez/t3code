import { describe, expect, it } from "vite-plus/test";

import { resolveThreadSyncPhase, threadSyncLabel } from "./threadSync";

describe("resolveThreadSyncPhase", () => {
  it("loads when only shell data is available", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: true,
        status: "synchronizing",
      }),
    ).toBe("loading");
  });

  it("syncs when cached detail is already visible", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "cached",
      }),
    ).toBe("syncing");
  });

  it("does not report a sync phase without a shell or after going live", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: false,
        status: "empty",
      }),
    ).toBeNull();
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "live",
      }),
    ).toBeNull();
  });
});

describe("threadSyncLabel", () => {
  it("keeps active work visible while thread details load", () => {
    expect(threadSyncLabel("loading", true)).toBe("Agent working · Loading messages...");
    expect(threadSyncLabel("syncing", true)).toBe("Agent working · Syncing messages...");
  });

  it("shows only synchronization state for an idle thread", () => {
    expect(threadSyncLabel("loading", false)).toBe("Loading messages...");
  });
});
