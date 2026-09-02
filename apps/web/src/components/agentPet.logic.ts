export const AGENT_PET_STATES = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
] as const;

export type AgentPetState = (typeof AGENT_PET_STATES)[number];

export const AGENT_PET_ANIMATIONS = {
  idle: { row: 0, frames: 6, durationMs: 1_100 },
  "running-right": { row: 1, frames: 8, durationMs: 1_060 },
  "running-left": { row: 2, frames: 8, durationMs: 1_060 },
  waving: { row: 3, frames: 4, durationMs: 700 },
  jumping: { row: 4, frames: 5, durationMs: 840 },
  failed: { row: 5, frames: 8, durationMs: 1_220 },
  waiting: { row: 6, frames: 6, durationMs: 1_010 },
  running: { row: 7, frames: 6, durationMs: 820 },
  review: { row: 8, frames: 6, durationMs: 1_030 },
} as const satisfies Record<AgentPetState, { row: number; frames: number; durationMs: number }>;

export function resolveAgentPetState(input: {
  readonly hasError: boolean;
  readonly isWaitingForUser: boolean;
  readonly isReviewing: boolean;
  readonly isWorking: boolean;
}): AgentPetState {
  if (input.hasError) return "failed";
  if (input.isWaitingForUser) return "waiting";
  if (input.isReviewing) return "review";
  if (input.isWorking) return "running";
  return "idle";
}

export function resolveAgentPetSpeech(input: {
  readonly latestTurn: {
    readonly state: "running" | "interrupted" | "completed" | "error";
    readonly completedAt: string | null;
  } | null;
  readonly hasError: boolean;
  readonly isWorking: boolean;
}): string {
  if (input.hasError) return "Ostatnie zadanie: nie udało się.";
  if (input.isWorking || input.latestTurn?.state === "running") return "Pracuję nad zadaniem...";
  if (!input.latestTurn?.completedAt) return "Gotowy do pracy.";

  if (input.latestTurn.state === "completed") return "Ostatnie zadanie wykonane.";
  return "Ostatnie zadanie: nie udało się.";
}
