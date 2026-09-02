import type { CSSProperties } from "react";

import { AGENT_PET_ANIMATIONS, type AgentPetState } from "./agentPet.logic";

const DEFAULT_PET_SPRITESHEET = "/pets/pixelowy-mowca/spritesheet.webp";

export function AgentPet({ state }: { readonly state: AgentPetState }) {
  const animation = AGENT_PET_ANIMATIONS[state];
  const style = {
    "--agent-pet-row": animation.row,
    "--agent-pet-duration": `${animation.durationMs}ms`,
    backgroundImage: `url(${DEFAULT_PET_SPRITESHEET})`,
  } as CSSProperties;

  return (
    <div
      aria-label={`Agent companion: ${state}`}
      className="agent-pet"
      data-frames={animation.frames}
      data-state={state}
      role="img"
      style={style}
    />
  );
}
