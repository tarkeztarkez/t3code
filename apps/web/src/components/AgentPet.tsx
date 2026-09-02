import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";

import { AGENT_PET_ANIMATIONS, type AgentPetState } from "./agentPet.logic";

const DEFAULT_PET_SPRITESHEET = "/pets/pixelowy-mowca/spritesheet.webp";
const PET_POSITION_STORAGE_KEY = "t3-agent-pet-position";
const PET_FRAME_WIDTH = 96;
const PET_FRAME_HEIGHT = 104;

type PetPosition = { readonly left: number; readonly top: number };
type PetDrag = PetPosition & { readonly pointerId: number };

function clampPetPosition(position: PetPosition): PetPosition {
  if (typeof window === "undefined") return position;
  const maxLeft = Math.max(0, window.innerWidth - PET_FRAME_WIDTH);
  const maxTop = Math.max(0, window.innerHeight - PET_FRAME_HEIGHT);
  return {
    left: Math.max(0, Math.min(position.left, maxLeft)),
    top: Math.max(0, Math.min(position.top, maxTop)),
  };
}

function readStoredPetPosition(): PetPosition | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(PET_POSITION_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Partial<PetPosition>;
    if (typeof parsed.left !== "number" || typeof parsed.top !== "number") return null;
    return { left: parsed.left, top: parsed.top };
  } catch {
    return null;
  }
}

export function AgentPet({
  state,
  speech,
}: {
  readonly state: AgentPetState;
  readonly speech: string;
}) {
  const [position, setPosition] = useState<PetPosition | null>(null);
  const [dragging, setDragging] = useState(false);
  const [, forceViewportRefresh] = useState(0);
  const dragRef = useRef<PetDrag | null>(null);
  const animation = AGENT_PET_ANIMATIONS[state];

  useEffect(() => {
    setPosition(readStoredPetPosition());
  }, []);

  useEffect(() => {
    const refresh = () => forceViewportRefresh((value) => value + 1);
    window.addEventListener("resize", refresh);
    window.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("resize", refresh);
      window.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  const persistPosition = useCallback((nextPosition: PetPosition) => {
    const clamped = clampPetPosition(nextPosition);
    setPosition(clamped);
    try {
      window.localStorage.setItem(PET_POSITION_STORAGE_KEY, JSON.stringify(clamped));
    } catch {
      // Keep dragging working even when storage is unavailable.
    }
  }, []);

  const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      left: event.clientX - rect.left,
      top: event.clientY - rect.top,
    };
    setDragging(true);
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      persistPosition({
        left: event.clientX - drag.left,
        top: event.clientY - drag.top,
      });
    },
    [persistPosition],
  );

  const handlePointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const visiblePosition = position ? clampPetPosition(position) : null;
  const shellStyle = visiblePosition
    ? ({ left: visiblePosition.left, top: visiblePosition.top, bottom: "auto" } as CSSProperties)
    : undefined;
  const spriteStyle = {
    "--agent-pet-row": animation.row,
    "--agent-pet-duration": `${animation.durationMs}ms`,
    backgroundImage: `url(${DEFAULT_PET_SPRITESHEET})`,
  } as CSSProperties;

  const pet = (
    <div
      aria-label={`Agent companion: ${state}`}
      className="agent-pet-shell"
      data-dragging={dragging}
      onLostPointerCapture={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      role="group"
      style={shellStyle}
    >
      <div className="agent-pet-speech" role="status">
        {speech}
      </div>
      <div
        className="agent-pet"
        data-frames={animation.frames}
        data-state={state}
        role="img"
        style={spriteStyle}
      />
    </div>
  );

  return typeof document === "undefined" ? pet : createPortal(pet, document.body);
}
