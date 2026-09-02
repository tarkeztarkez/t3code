import { BrowserWindow, screen, type Rectangle } from "electron";

const PET_WINDOW_WIDTH = 272;
const PET_WINDOW_HEIGHT = 164;
const PET_FRAME_WIDTH = 96;
const PET_FRAME_HEIGHT = 104;

export interface AgentPetOverlayUpdate {
  readonly visible: boolean;
  readonly state: string;
  readonly speech: string;
  readonly row: number;
  readonly frames: number;
  readonly durationMs: number;
}

let overlayWindow: BrowserWindow | null = null;
let overlayOwner: BrowserWindow | null = null;
let lastBounds: Rectangle | null = null;
let updateQueue: Promise<void> = Promise.resolve();

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function defaultBounds(): Rectangle {
  const workArea = screen.getPrimaryDisplay().workArea;
  return {
    x: workArea.x + 20,
    y: workArea.y + workArea.height - PET_WINDOW_HEIGHT - 20,
    width: PET_WINDOW_WIDTH,
    height: PET_WINDOW_HEIGHT,
  };
}

export function buildAgentPetOverlayDataUrl(
  spritesheetUrl: string,
  input: AgentPetOverlayUpdate,
): string {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src t3code: t3code-dev:; style-src 'unsafe-inline'">
    <style>
      html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
      body{display:flex;align-items:flex-end;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-user-select:none;user-select:none;-webkit-app-region:drag}
      #pet-shell{display:flex;flex-direction:column;align-items:flex-start;width:100%;cursor:grab}
      #speech{box-sizing:border-box;max-width:260px;margin:0 6px -4px;padding:7px 10px;border:1px solid rgba(127,127,127,.35);border-radius:14px 14px 14px 4px;background:rgba(24,24,27,.9);color:#fafafa;font-size:12px;line-height:18px;box-shadow:0 8px 24px rgba(0,0,0,.2);backdrop-filter:blur(12px)}
      #pet{width:${PET_FRAME_WIDTH}px;height:${PET_FRAME_HEIGHT}px;pointer-events:none;background-image:url("${escapeHtml(spritesheetUrl)}");background-repeat:no-repeat;background-size:768px 936px;background-position:0 calc(var(--pet-row) * -${PET_FRAME_HEIGHT}px);animation-duration:var(--pet-duration);animation-iteration-count:infinite;animation-timing-function:step-end;filter:drop-shadow(0 6px 7px rgba(0,0,0,.2))}
      #pet[data-frames="4"]{animation-name:frames-4}#pet[data-frames="5"]{animation-name:frames-5}#pet[data-frames="6"]{animation-name:frames-6}#pet[data-frames="8"]{animation-name:frames-8}
      @keyframes frames-4{0%,100%{background-position:0 calc(var(--pet-row)*-${PET_FRAME_HEIGHT}px)}25%{background-position:-96px calc(var(--pet-row)*-${PET_FRAME_HEIGHT}px)}50%{background-position:-192px calc(var(--pet-row)*-${PET_FRAME_HEIGHT}px)}75%{background-position:-288px calc(var(--pet-row)*-${PET_FRAME_HEIGHT}px)}}
      @keyframes frames-5{0%,100%{background-position:0 calc(var(--pet-row)*-${PET_FRAME_HEIGHT}px)}20%{background-position:-96px calc(var(--pet-row)*-${PET_FRAME_HEIGHT}px)}40%{background-position:-192px calc(var(--pet-row)*-${PET_FRAME_HEIGHT}px)}60%{background-position:-288px calc(var(--pet-row)*-${PET_FRAME_HEIGHT}px)}80%{background-position:-384px calc(var(--pet-row)*-${PET_FRAME_HEIGHT}px)}}
      @keyframes frames-6{0%,100%{background-position:0 calc(var(--pet-row)*-${PET_FRAME_HEIGHT}px)}16.667%{background-position:-96px calc(var(--pet-row)*-${PET_FRAME_HEIGHT}px)}33.333%{background-position:-192px calc(var(--pet-row)*-${PET_FRAME_HEIGHT}px)}50%{background-position:-288px calc(var(--pet-row)*-${PET_FRAME_HEIGHT}px)}66.667%{background-position:-384px calc(var(--pet-row)*-${PET_FRAME_HEIGHT}px)}83.333%{background-position:-480px calc(var(--pet-row)*-${PET_FRAME_HEIGHT}px)}}
      @keyframes frames-8{0%,100%{background-position:0 calc(var(--pet-row)*-${PET_FRAME_HEIGHT}px)}12.5%{background-position:-96px calc(var(--pet-row)*-${PET_FRAME_HEIGHT}px)}25%{background-position:-192px calc(var(--pet-row)*-${PET_FRAME_HEIGHT}px)}37.5%{background-position:-288px calc(var(--pet-row)*-${PET_FRAME_HEIGHT}px)}50%{background-position:-384px calc(var(--pet-row)*-${PET_FRAME_HEIGHT}px)}62.5%{background-position:-480px calc(var(--pet-row)*-${PET_FRAME_HEIGHT}px)}75%{background-position:-576px calc(var(--pet-row)*-${PET_FRAME_HEIGHT}px)}87.5%{background-position:-672px calc(var(--pet-row)*-${PET_FRAME_HEIGHT}px)}}
      @media(prefers-reduced-motion:reduce){#pet{animation:none}}
    </style>
  </head>
  <body>
    <div id="pet-shell">
      <div id="speech">${escapeHtml(input.speech)}</div>
      <div id="pet" role="img" aria-label="Agent companion: ${escapeHtml(input.state)}" data-frames="${input.frames}" style="--pet-row:${input.row};--pet-duration:${input.durationMs}ms"></div>
    </div>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function closeOverlay(): void {
  const window = overlayWindow;
  overlayWindow = null;
  if (window !== null && !window.isDestroyed()) window.close();
}

function bindOwner(owner: BrowserWindow): void {
  if (overlayOwner === owner) return;
  overlayOwner?.removeListener("closed", closeOverlay);
  overlayOwner = owner;
  owner.once("closed", closeOverlay);
}

async function createOverlay(
  owner: BrowserWindow,
  spritesheetUrl: string,
  input: AgentPetOverlayUpdate,
): Promise<BrowserWindow> {
  const bounds = lastBounds ?? defaultBounds();
  const window = new BrowserWindow({
    ...bounds,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    // Let the pet receive native drag hit-tests without activating T3 and
    // pulling its main window in front of the app the user is working in.
    focusable: false,
    frame: false,
    fullscreenable: false,
    hasShadow: false,
    maximizable: false,
    minimizable: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    transparent: true,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  overlayWindow = window;
  bindOwner(owner);
  window.setAlwaysOnTop(true, "screen-saver", 1);
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.on("move", () => {
    if (!window.isDestroyed()) lastBounds = window.getBounds();
  });
  window.once("closed", () => {
    if (overlayWindow === window) overlayWindow = null;
  });
  await window.loadURL(buildAgentPetOverlayDataUrl(spritesheetUrl, input));
  window.showInactive();
  return window;
}

async function performUpdate(
  owner: BrowserWindow,
  spritesheetUrl: string,
  input: AgentPetOverlayUpdate,
): Promise<void> {
  if (!input.visible) {
    closeOverlay();
    return;
  }

  const window =
    overlayWindow === null || overlayWindow.isDestroyed()
      ? await createOverlay(owner, spritesheetUrl, input)
      : overlayWindow;
  bindOwner(owner);
  window.setAlwaysOnTop(true, "screen-saver", 1);
  const serialized = JSON.stringify(input).replaceAll("<", "\\u003c");
  const source = `(() => { const input = JSON.parse(${JSON.stringify(serialized)}); const speech = document.getElementById("speech"); const pet = document.getElementById("pet"); if (!speech || !pet) return; speech.textContent = input.speech; pet.dataset.frames = String(input.frames); pet.setAttribute("aria-label", "Agent companion: " + input.state); pet.style.setProperty("--pet-row", String(input.row)); pet.style.setProperty("--pet-duration", input.durationMs + "ms"); })()`;
  await window.webContents.executeJavaScript(source, true);
}

export function updateAgentPetOverlay(
  owner: BrowserWindow,
  spritesheetUrl: string,
  input: AgentPetOverlayUpdate,
): Promise<void> {
  const update = updateQueue.then(() => performUpdate(owner, spritesheetUrl, input));
  updateQueue = update.catch(() => undefined);
  return update;
}
