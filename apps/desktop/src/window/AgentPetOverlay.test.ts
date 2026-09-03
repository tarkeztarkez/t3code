import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
}));

import { AGENT_PET_WINDOW_TITLE, buildAgentPetOverlayDataUrl } from "./AgentPetOverlay.ts";

describe("buildAgentPetOverlayDataUrl", () => {
  it("builds a draggable transparent pet document with the selected animation", () => {
    const url = buildAgentPetOverlayDataUrl("t3code://app/pets/pet.webp", {
      visible: true,
      state: "running",
      speech: "Pracuję <nad> zadaniem...",
      row: 7,
      frames: 6,
      durationMs: 820,
    });
    const html = decodeURIComponent(url.slice("data:text/html;charset=utf-8,".length));

    expect(html).toContain("-webkit-app-region:drag");
    expect(html).toContain(`<title>${AGENT_PET_WINDOW_TITLE}</title>`);
    expect(html).toContain('background-image:url("t3code://app/pets/pet.webp")');
    expect(html).toContain('data-frames="6"');
    expect(html).toContain("--pet-row:7;--pet-duration:820ms");
    expect(html).toContain("Pracuję &lt;nad&gt; zadaniem...");
    expect(html).not.toContain("Pracuję <nad> zadaniem...");
  });
});
