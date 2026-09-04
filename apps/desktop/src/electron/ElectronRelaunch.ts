import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface ElectronRelaunchOptions {
  readonly execPath: string;
  readonly args: ReadonlyArray<string>;
}

export function disableAppImageLauncherForRelaunch(environment: NodeJS.ProcessEnv): void {
  // AppImageLauncher watches integrated AppImages and may still be processing
  // a newly replaced file when Electron starts it again. Bypass that
  // integration pass for the relaunch. The AppImage runtime still mounts and
  // starts the file normally.
  environment.APPIMAGELAUNCHER_DISABLE = "1";
}

export class ElectronRelaunch extends Context.Service<
  ElectronRelaunch,
  {
    readonly relaunch: (options: ElectronRelaunchOptions) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronRelaunch") {}

export const layer = (relaunch: ElectronRelaunch["Service"]["relaunch"]) =>
  Layer.succeed(ElectronRelaunch, ElectronRelaunch.of({ relaunch }));
