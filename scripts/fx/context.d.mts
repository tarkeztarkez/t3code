export function loadContext(options: { cwd: string; home?: string; agentDir?: string }): Promise<{
  prompt: string;
  instructions: { path: string; text: string }[];
  skills: { name: string; description: string; path: string }[];
}>;
