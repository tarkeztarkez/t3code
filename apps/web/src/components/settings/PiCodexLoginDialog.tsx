import type { PiCodexLoginStartResult } from "@t3tools/contracts";
import { ExternalLinkIcon, LoaderIcon } from "lucide-react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export function PiCodexLoginDialog(props: {
  readonly login: PiCodexLoginStartResult;
  readonly completing: boolean;
  readonly onComplete: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && props.onCancel()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Connect Pi to ChatGPT</DialogTitle>
          <DialogDescription>
            Open the OpenAI device page, enter this code, then return here to finish.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="rounded-lg border border-border bg-muted/30 px-4 py-5 text-center">
            <code className="text-2xl font-semibold tracking-[0.2em] text-foreground">
              {props.login.userCode}
            </code>
          </div>
          <Button
            render={<a href={props.login.verificationUri} target="_blank" rel="noreferrer" />}
          >
            <ExternalLinkIcon />
            Open OpenAI
          </Button>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button disabled={props.completing} onClick={props.onComplete}>
            {props.completing ? <LoaderIcon className="animate-spin" /> : null}
            {props.completing ? "Waiting for OpenAI" : "Finish login"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
