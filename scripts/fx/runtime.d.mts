export interface FxCodeOptions {
  readonly engine: "bun" | "quickjs" | "quickjs-isolated";
  readonly executable: string;
  readonly code: string;
  readonly tools?: Readonly<Record<string, (input: unknown, signal: AbortSignal) => unknown>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onReady?: (pid: number) => void | Promise<void>;
}

export function executeCode(options: FxCodeOptions): Promise<{
  output: unknown[];
  elapsedMs: number;
}>;
