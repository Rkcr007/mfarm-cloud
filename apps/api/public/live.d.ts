/**
 * Types for `live.js`, which is a BROWSER ASSET and stays plain JavaScript.
 *
 * The console has no build step on purpose — the API serves these files exactly as they are on disk,
 * which is why a deploy is one image and why "is my fix live?" is a browser refresh. So this file
 * declares types and generates nothing; `live.js` remains the only implementation.
 *
 * It exists for two reasons now.
 *
 * 1. The inspector's hit test and selector ranking are unit-tested from TypeScript, and those two
 *    functions decide whether someone's Appium selector matches the right element.
 * 2. Since 2026-09-02 the React console at `/app` IMPORTS this file rather than reimplementing it.
 *    Two implementations of Cuttlefish's signalling vocabulary would drift, and this file's own
 *    header says it is the only place in the repo that knows it — so the new console shares the
 *    proven one and this declaration is what lets it do so under `strict`.
 *
 * The old console still loads `live.js` from disk unbuilt; the React one bundles the same source
 * through Vite. One implementation, two delivery mechanisms.
 */

/** One node from a uiautomator dump, with bounds resolved to numbers. */
export interface UiNode {
  i: number;
  cls: string;
  pkg: string;
  text: string;
  desc: string;
  id: string;
  clickable: boolean;
  enabled: boolean;
  scrollable: boolean;
  x1: number; y1: number; x2: number; y2: number;
  /** Width times height. The hit test sorts on it, so the smallest node under a point wins. */
  area: number;
}

/** How well a selector is expected to survive the next build. */
export type SelectorQuality = 'stable' | 'ok' | 'brittle';

export interface Selector {
  /** Human label for the row, e.g. `xpath by text`. */
  how: string;
  /** The Appium locator strategy to pass alongside `value`. */
  strategy: string;
  value: string;
  quality: SelectorQuality;
  note?: string;
}

export function parseHierarchy(xml: string): UiNode[];
export function nodeAt(nodes: UiNode[], x: number, y: number): UiNode | null;
export function selectorsFor(node: UiNode, nodes: UiNode[]): Selector[];

export const ATTACHED: Set<string>;

/**
 * Control-channel button command -> the data plane's `KeyName`.
 *
 * Declared because a test asserts every value is a name the agent will accept: a typo here is a
 * console button that renders enabled and does nothing, which is the failure this map was added to
 * fix in the first place.
 */
export const BUTTON_KEY: Record<string, string>;
export const STATES: string[];
export function parseLogLine(line: string): {
  time: string; pid?: string; tid?: string; level: string; tag: string; message: string; raw: string;
};
/** Connection state, from `STATES`. */
export type LiveState =
  | 'idle' | 'connecting' | 'authenticated' | 'negotiating'
  | 'streaming' | 'nostream' | 'nodisplay' | 'closed' | 'failed';

/** The panel the control plane believes this device has. Input is scaled against the VIDEO, not this. */
export interface LiveScreen { width: number; height: number; density: number }

export interface LiveStats {
  fps: number;
  kbps: number;
  /** Round trip in ms on the nominated candidate pair, or null before one is nominated. */
  rtt: number | null;
  /** `host` | `srflx` | `relay` — `relay` means media is going through coturn. */
  ice: string | null;
}

export interface LiveScreenshot { data: string; contentType: string; takenAt: string }

export interface LiveSessionOptions {
  /** wss url for this session's host, from `dataPlane.browserEndpoint`. */
  url: string;
  /** The Ed25519 grant, from `dataPlane.token`. */
  token: string;
  /** Control-plane-minted TURN. Wins over whatever the host suggests. */
  iceServers?: RTCIceServer[];
  onState?: (state: LiveState, detail?: string) => void;
  onStream?: (stream: MediaStream, label: string) => void;
  onLog?: (lines: string[]) => void;
  onScreenshot?: (shot: LiveScreenshot) => void;
  /** Non-fatal: a dropped log batch, a refused verb. NOT a reason to tear the view down. */
  onNotice?: (message: string) => void;
  onInspectPick?: (x: number, y: number) => void;
}

/**
 * THE INDEX SIGNATURE IS GONE — replaced 2026-09-02 when the React console at `/app` began sharing
 * this file rather than reimplementing it.
 *
 * It used to read `[key: string]: unknown`, which typed every method as `unknown` and therefore as
 * not callable. That was survivable while the only TypeScript readers were tests that cast to `any`
 * (`test/live-buttons.test.ts`, `test/inspector.test.ts`, which still do and still pass). It is not
 * survivable for a consumer that actually calls `connect()`.
 *
 * Only the surface used outside this file is declared. The private fields stay undeclared on
 * purpose: a test that reaches for `live.ws` is describing an injected fake, and it should have to
 * cast to say so.
 */
export class LiveSession {
  constructor(o: LiveSessionOptions);
  readonly state: LiveState;
  readonly stats: LiveStats;
  /** The stream id, which is also the `device_label` the device matches touches against. */
  readonly label: string;
  screen: LiveScreen | null;
  capabilities: string[];
  /** While true, a pointer press selects an element and NOTHING reaches the device. */
  inspectMode?: boolean;
  connect(): void;
  /** Idempotent. Closes the peer connection and the socket, and reports `closed`. */
  close(): void;
  /** Binds pointer and keyboard input. Call once per `<video>` element. */
  attachInput(video: HTMLVideoElement): void;
  startLogcat(): void;
  stopLogcat(): void;
  /** Raw data-plane message (volume, rotate). False when the socket is not open. */
  sendControl(msg: Record<string, unknown>): boolean;
  /** A hardware button over the datachannel where one exists, else the data-plane socket. */
  pressButton(command: string): boolean;
  uiDump(): Promise<{ id: string; xml: string }>;
  screenshot(): Promise<LiveScreenshot & { id: string }>;
}
