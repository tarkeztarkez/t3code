import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface ElectronRelaunchOptions {
  readonly execPath: string;
  readonly args: ReadonlyArray<string>;
}

export class ElectronRelaunch extends Context.Service<
  ElectronRelaunch,
  {
    readonly relaunch: (options: ElectronRelaunchOptions) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronRelaunch") {}

export const layer = (relaunch: ElectronRelaunch["Service"]["relaunch"]) =>
  Layer.succeed(ElectronRelaunch, ElectronRelaunch.of({ relaunch }));
