/**
 * Types for `live.js`, which is a BROWSER ASSET and stays plain JavaScript.
 *
 * The console has no build step on purpose — the API serves these files exactly as they are on disk,
 * which is why a deploy is one image and why "is my fix live?" is a browser refresh. So this file
 * declares types and generates nothing; `live.js` remains the only implementation.
 *
 * It exists because the inspector's hit test and selector ranking are unit-tested from TypeScript,
 * and those two functions decide whether someone's Appium selector matches the right element. That
 * is worth a type. Only the exports used outside the browser are described.
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
export const STATES: string[];
export function parseLogLine(line: string): {
  time: string; pid?: string; tid?: string; level: string; tag: string; message: string; raw: string;
};
export class LiveSession {
  constructor(o: Record<string, unknown>);
  [key: string]: unknown;
}
