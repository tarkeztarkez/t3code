import { describe, expect, it } from "vite-plus/test";

import { AGENT_PET_ANIMATIONS, resolveAgentPetState } from "./agentPet.logic";

describe("resolveAgentPetState", () => {
  const resting = {
    hasError: false,
    isWaitingForUser: false,
    isReviewing: false,
    isWorking: false,
  };

  it("maps the thread lifecycle to visible pet states", () => {
    expect(resolveAgentPetState(resting)).toBe("idle");
    expect(resolveAgentPetState({ ...resting, isWorking: true })).toBe("running");
    expect(resolveAgentPetState({ ...resting, isReviewing: true })).toBe("review");
    expect(resolveAgentPetState({ ...resting, isWaitingForUser: true })).toBe("waiting");
    expect(resolveAgentPetState({ ...resting, hasError: true })).toBe("failed");
  });

  it("prioritizes errors and user input over background work", () => {
    expect(
      resolveAgentPetState({
        hasError: true,
        isWaitingForUser: true,
        isReviewing: true,
        isWorking: true,
      }),
    ).toBe("failed");
    expect(
      resolveAgentPetState({
        hasError: false,
        isWaitingForUser: true,
        isReviewing: true,
        isWorking: true,
      }),
    ).toBe("waiting");
  });
});

describe("AGENT_PET_ANIMATIONS", () => {
  it("matches the nine-row Codex pet atlas contract", () => {
    expect(Object.values(AGENT_PET_ANIMATIONS).map(({ row }) => row)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(AGENT_PET_ANIMATIONS.idle.frames).toBe(6);
    expect(AGENT_PET_ANIMATIONS["running-right"].frames).toBe(8);
    expect(AGENT_PET_ANIMATIONS["running-left"].frames).toBe(8);
  });
});
