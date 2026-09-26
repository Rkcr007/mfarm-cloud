import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { ControlPlaneClient, describe } from './client.ts';
import {
  HubClient, HubError, elementId, tapActions, swipeActions, ANDROID_KEYCODES, type DeviceKey,
} from './hub.ts';
import { parseUiTree, formatUiTree, uiElementCenter, type UiElement } from './wire.ts';

/**
 * `mfarm mcp` — a Model Context Protocol server that lets an AI agent drive a farm device.
 *
 * ADR-0043, capability C1. The customer's agent (Claude Code, Cursor, Codex, Google's Artemis…) is
 * the process; this server is a WebDriver client of `/wd/hub` with a vocabulary an agent can use.
 * That keeps it inside ADR-0018: MFARM supplies the device and records what happened, and the thing
 * deciding what to tap is the customer's.
 *
 * TRANSPORT: stdio, newline-delimited JSON-RPC 2.0 — what every MCP client launches a local server
 * with. STDOUT CARRIES PROTOCOL AND NOTHING ELSE; a stray log line there is a parse error in the
 * client and a dead connection. Diagnostics go to stderr.
 *
 * ONE DEVICE AT A TIME per server. An agent that holds two phones is an agent that forgets one, and
 * a forgotten phone is billed until its TTL. `start_session` refuses while one is open; the device is
 * released on `end_session`, on stdin closing, and on SIGINT/SIGTERM — the three ways an MCP client
 * stops a server.
 */

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
interface ToolResult { content: Content[]; isError?: boolean }

const int = (description: string) => ({ type: 'integer', description });

export const TOOLS: Tool[] = [
  {
    name: 'list_devices',
    description: 'List the farm devices your organisation can use, with their state (READY means free now).',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['android', 'ios'] },
        region: { type: 'string' },
      },
    },
  },
  {
    name: 'list_apps',
    description: 'List app builds in your organisation\'s library. Pass an id to start_session to install it.',
    inputSchema: { type: 'object', properties: { package: { type: 'string', description: 'Filter to one package/bundle id.' } } },
  },
  {
    name: 'start_session',
    description:
      'Borrow a device. Optionally installs and launches an app build first. Only one session at a time; '
      + 'call end_session when done — the device is billed while held. May wait for a free device.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['android', 'ios'], description: 'Default android.' },
        region: { type: 'string', description: 'Default: MFARM_REGION, else the farm default.' },
        appId: { type: 'string', description: 'Build to install first: a build id, pkg@version or pkg@latest.' },
        ttlMinutes: int('How long the device may be held, 1-240. Default 30.'),
        name: { type: 'string', description: 'What this session is for; shown in the console.' },
      },
    },
  },
  {
    name: 'screenshot',
    description: 'Take a screenshot of the current screen.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ui_tree',
    description:
      'List the readable/tappable elements on screen as numbered lines with their centre point. '
      + 'Prefer tapping by index. Empty on canvas/game screens — use the screenshot there.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tap',
    description: 'Tap an element by its index from the latest ui_tree, or at x,y.',
    inputSchema: {
      type: 'object',
      properties: { index: int('Element index from ui_tree.'), x: int('X coordinate.'), y: int('Y coordinate.') },
    },
  },
  {
    name: 'type_text',
    description: 'Type text into the focused field. Pass index to tap a field first.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, index: int('Element index from ui_tree to tap first.') },
      required: ['text'],
    },
  },
  {
    name: 'swipe',
    description: 'Swipe from one point to another (scroll by swiping the opposite way).',
    inputSchema: {
      type: 'object',
      properties: {
        fromX: int('Start X.'), fromY: int('Start Y.'), toX: int('End X.'), toY: int('End Y.'),
        durationMs: int('Default 300.'),
      },
      required: ['fromX', 'fromY', 'toX', 'toY'],
    },
  },
  {
    name: 'press_key',
    description: 'Press a device key. iOS supports home only.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', enum: Object.keys(ANDROID_KEYCODES) } },
      required: ['key'],
    },
  },
  {
    name: 'launch_app',
    description: 'Bring an installed app to the foreground by package name (Android) or bundle id (iOS).',
    inputSchema: { type: 'object', properties: { appId: { type: 'string' } }, required: ['appId'] },
  },
  {
    name: 'device_logs',
    description: 'Recent device log lines (logcat on Android, syslog on iOS) since the last call.',
    inputSchema: {
      type: 'object',
      properties: {
        lines: int('How many of the newest lines to return, default 100, max 1000.'),
        grep: { type: 'string', description: 'Only lines containing this text (case-insensitive).' },
      },
    },
  },
  {
    name: 'end_session',
    description: 'Give the device back. Always call this when finished.',
    inputSchema: { type: 'object', properties: {} },
  },
];

interface Active {
  sessionId: string;
  platform: 'android' | 'ios';
  elements: UiElement[];
}

export interface McpOptions {
  apiBaseUrl: string;
  apiKey: string;
  defaultRegion?: string;
  input: Readable;
  output: Writable;
  log: (line: string) => void;
  version: string;
}

export class McpServer {
  private readonly hub: HubClient;
  private readonly api: ControlPlaneClient;
  private active: Active | null = null;
  /**
   * Set for the whole of an allocation. Requests are handled concurrently (see `serve`), so without
   * it two `start_session` calls in flight together would both see `active === null` and hold two
   * devices — exactly the forgotten phone the one-at-a-time rule exists to prevent.
   */
  private starting = false;
  private readonly opts: McpOptions;

  constructor(opts: McpOptions) {
    this.opts = opts;
    this.hub = new HubClient({ apiBaseUrl: opts.apiBaseUrl, apiKey: opts.apiKey });
    this.api = new ControlPlaneClient({ baseUrl: opts.apiBaseUrl, apiKey: opts.apiKey });
  }

  /** Serve until stdin closes, then release anything still held. */
  async serve(): Promise<void> {
    const rl = createInterface({ input: this.opts.input, crlfDelay: Infinity });
    const pending = new Set<Promise<void>>();
    for await (const line of rl) {
      if (!line.trim()) continue;
      // Requests are handled concurrently so a slow allocation does not block `ping`; the tools
      // themselves serialise on the one device, which the agent drives turn by turn anyway.
      const p = this.handleLine(line).finally(() => pending.delete(p));
      pending.add(p);
    }
    await Promise.allSettled(pending);
    await this.releaseActive('the MCP client disconnected');
  }

  /** For signal handlers: give the device back before the process goes. */
  async shutdown(reason: string): Promise<void> {
    await this.releaseActive(reason);
  }

  private send(message: unknown): void {
    this.opts.output.write(`${JSON.stringify(message)}\n`);
  }

  private async handleLine(line: string): Promise<void> {
    let msg: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      this.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const isRequest = msg.id !== undefined && msg.id !== null;
    try {
      const result = await this.dispatch(msg.method ?? '', msg.params ?? {});
      if (isRequest) this.send({ jsonrpc: '2.0', id: msg.id, result });
    } catch (err) {
      if (!isRequest) return;
      const code = err instanceof RpcError ? err.code : -32603;
      this.send({ jsonrpc: '2.0', id: msg.id, error: { code, message: describe(err) } });
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const asked = String(params.protocolVersion ?? '');
        const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked)
          ? asked : MCP_PROTOCOL_VERSIONS[0];
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'mfarm', version: this.opts.version },
          instructions:
            'Drives a real phone on the MFARM device farm. Start with start_session, then loop: '
            + 'ui_tree (and screenshot when the tree is empty or ambiguous) → one action → check. '
            + 'Always end_session when finished; the device is billed while held.',
        };
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS };
      case 'tools/call': {
        const name = String(params.name ?? '');
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (!TOOLS.some((t) => t.name === name)) throw new RpcError(-32602, `Unknown tool: ${name}`);
        try {
          return await this.callTool(name, args);
        } catch (err) {
          // A failed tool is a RESULT the agent should read and recover from, not a protocol error.
          return errorResult(err);
        }
      }
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }

  async callTool(name: string, a: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'list_devices': {
        const r = await this.api.listDevices({ platform: str(a.platform), region: str(a.region) });
        const lines = r.devices.map((d) =>
          `${d.id}  ${d.state}  ${d.platform}/${d.tier}  ${d.model ?? '?'}  ${d.osVersion ?? '?'}  ${d.region}`);
        return text(`${r.available} of ${r.devices.length} ready\n${lines.join('\n')}`);
      }
      case 'list_apps': {
        const apps = await this.api.listApps(str(a.package));
        if (apps.length === 0) return text('The library is empty. Upload a build with `mfarm app upload`.');
        return text(apps.map((x) =>
          `${x.id}  ${x.packageName}  ${x.versionName ?? '?'} (${x.versionCode ?? '?'})`).join('\n'));
      }
      case 'start_session':
        return this.startSession(a);
      case 'end_session': {
        if (!this.active) return text('No session is open.');
        const id = this.active.sessionId;
        await this.releaseActive('end_session');
        return text(`Released session ${id}.`);
      }
    }

    const s = this.requireActive();
    switch (name) {
      case 'screenshot': {
        const b64 = await this.hub.command(s.sessionId, 'GET', 'screenshot');
        if (typeof b64 !== 'string') throw new Error('The device returned no screenshot.');
        return { content: [{ type: 'image', data: b64, mimeType: 'image/png' }] };
      }
      case 'ui_tree': {
        const xml = await this.hub.command(s.sessionId, 'GET', 'source');
        s.elements = parseUiTree(typeof xml === 'string' ? xml : '');
        return text(formatUiTree(s.elements));
      }
      case 'tap': {
        const p = this.point(s, a);
        await this.hub.command(s.sessionId, 'POST', 'actions', tapActions(p.x, p.y));
        return text(`Tapped ${p.x},${p.y}${p.what}.`);
      }
      case 'type_text': {
        const value = str(a.text);
        if (value === undefined) throw new Error('text is required.');
        if (a.index !== undefined) {
          const p = this.point(s, { index: a.index });
          await this.hub.command(s.sessionId, 'POST', 'actions', tapActions(p.x, p.y));
        }
        // GET, per W3C: Appium 2 answers POST with "unknown command" (found on a real device, 2026-09-26).
        const el = elementId(await this.hub.command(s.sessionId, 'GET', 'element/active'));
        if (!el) throw new Error('No field has focus. Tap a text field first (pass index).');
        await this.hub.command(s.sessionId, 'POST', `element/${encodeURIComponent(el)}/value`, { text: value, value: [...value] });
        return text(`Typed ${value.length} character(s).`);
      }
      case 'swipe': {
        const [fx, fy, tx, ty] = [num(a.fromX), num(a.fromY), num(a.toX), num(a.toY)];
        if ([fx, fy, tx, ty].some((v) => v === undefined)) throw new Error('fromX, fromY, toX and toY are required.');
        await this.hub.command(s.sessionId, 'POST', 'actions', swipeActions(fx!, fy!, tx!, ty!, num(a.durationMs) ?? 300));
        return text(`Swiped ${fx},${fy} → ${tx},${ty}.`);
      }
      case 'press_key': {
        const key = str(a.key) as DeviceKey | undefined;
        if (!key || !(key in ANDROID_KEYCODES)) throw new Error(`key must be one of ${Object.keys(ANDROID_KEYCODES).join(', ')}.`);
        if (s.platform === 'ios') {
          if (key !== 'home') throw new Error('iOS has no back key; use a visible Back button, or swipe from the left edge.');
          await this.hub.command(s.sessionId, 'POST', 'execute/sync', { script: 'mobile: pressButton', args: [{ name: 'home' }] });
        } else {
          await this.hub.command(s.sessionId, 'POST', 'execute/sync', { script: 'mobile: pressKey', args: [{ keycode: ANDROID_KEYCODES[key] }] });
        }
        return text(`Pressed ${key}.`);
      }
      case 'launch_app': {
        const appId = str(a.appId);
        if (!appId) throw new Error('appId is required.');
        const args = s.platform === 'ios' ? { bundleId: appId } : { appId };
        await this.hub.command(s.sessionId, 'POST', 'execute/sync', { script: 'mobile: activateApp', args: [args] });
        return text(`Launched ${appId}.`);
      }
      case 'device_logs': {
        const want = Math.min(Math.max(num(a.lines) ?? 100, 1), 1000);
        const type = s.platform === 'ios' ? 'syslog' : 'logcat';
        const entries = await this.hub.command(s.sessionId, 'POST', 'se/log', { type });
        let lines = (Array.isArray(entries) ? entries : [])
          .map((e) => String((e as { message?: unknown }).message ?? ''));
        const needle = str(a.grep)?.toLowerCase();
        if (needle) lines = lines.filter((l) => l.toLowerCase().includes(needle));
        const tail = lines.slice(-want);
        return text(tail.length ? tail.join('\n') : '(no new log lines)');
      }
    }
    throw new RpcError(-32602, `Unknown tool: ${name}`);
  }

  private async startSession(a: Record<string, unknown>): Promise<ToolResult> {
    if (this.active) {
      throw new Error(`Session ${this.active.sessionId} is still open. Call end_session first.`);
    }
    if (this.starting) throw new Error('A session is already being started. Wait for it, then call end_session first.');
    this.starting = true;
    try {
      return await this.allocate(a);
    } finally {
      this.starting = false;
    }
  }

  private async allocate(a: Record<string, unknown>): Promise<ToolResult> {
    const platform = str(a.platform) ?? 'android';
    if (platform !== 'android' && platform !== 'ios') throw new Error('platform must be android or ios.');
    const ttl = num(a.ttlMinutes);
    if (ttl !== undefined && (ttl < 1 || ttl > 240)) throw new Error('ttlMinutes must be between 1 and 240.');
    const region = str(a.region) ?? this.opts.defaultRegion;

    const caps: Record<string, unknown> = {
      platformName: platform === 'ios' ? 'iOS' : 'Android',
      'appium:automationName': platform === 'ios' ? 'XCUITest' : 'UiAutomator2',
      'appium:newCommandTimeout': 300,
      // Waits out a busy farm rather than failing the agent's first call.
      'mfarm:queueTimeoutSeconds': 180,
      'mfarm:name': str(a.name) ?? 'mcp session',
      ...(region ? { 'mfarm:region': region } : {}),
      ...(ttl ? { 'mfarm:ttlMinutes': ttl } : {}),
      ...(str(a.appId) ? { 'mfarm:appId': str(a.appId) } : {}),
      ...(platform === 'android' ? { 'appium:autoGrantPermissions': true } : {}),
    };
    this.opts.log(`mfarm mcp: allocating a${platform === 'ios' ? 'n iOS' : 'n Android'} device…`);
    const s = await this.hub.newSession(caps);
    this.active = { sessionId: s.sessionId, platform, elements: [] };
    const device = await this.describeDevice(s.sessionId, platform, s.capabilities);
    return text(
      `Session ${s.sessionId} is open on ${device || `an ${platform} device`}.`
      + `${str(a.appId) ? ` ${str(a.appId)} is installed and launched.` : ''}`
      + ' Next: ui_tree or screenshot. Call end_session when done.',
    );
  }

  /**
   * "MFARM X1 · Android 17", from the control plane — not Appium's capabilities.
   *
   * Found on the farm, 2026-09-24: Appium's `deviceName` is the ADB serial and its `platformVersion`
   * a bare number, so the first hardware run announced "open on 0.0.0.0:6520 17". The hub's session
   * id IS the control plane's, so the device the allocator chose is one read away. Best effort — the
   * session is open either way, and saying so matters more than naming it.
   */
  private async describeDevice(sessionId: string, platform: string, caps: Record<string, unknown>): Promise<string> {
    const os = platform === 'ios' ? 'iOS' : 'Android';
    try {
      const { session } = await this.api.getSession(sessionId);
      if (session.deviceId) {
        const d = (await this.api.listDevices({})).devices.find((x) => x.id === session.deviceId);
        if (d) return `${d.model ?? 'a device'} \u00b7 ${os} ${d.osVersion ?? ''}`.trim();
      }
    } catch { /* fall through to what Appium said */ }
    const v = caps['appium:platformVersion'] ?? caps.platformVersion;
    return v ? `an ${os} ${String(v)} device` : `an ${os} device`;
  }

  private requireActive(): Active {
    if (!this.active) throw new Error('No session is open. Call start_session first.');
    return this.active;
  }

  private point(s: Active, a: Record<string, unknown>): { x: number; y: number; what: string } {
    const index = num(a.index);
    if (index !== undefined) {
      const el = s.elements[index];
      if (!el) {
        throw new Error(s.elements.length === 0
          ? 'No ui_tree has been read yet. Call ui_tree first, or tap by x,y.'
          : `No element [${index}] in the latest ui_tree (0-${s.elements.length - 1}). The screen may have changed — call ui_tree again.`);
      }
      const c = uiElementCenter(el);
      return { ...c, what: ` ([${index}] ${el.kind}${el.text ? ` "${el.text}"` : el.label ? ` "${el.label}"` : ''})` };
    }
    const x = num(a.x), y = num(a.y);
    if (x === undefined || y === undefined) throw new Error('Pass an index from ui_tree, or both x and y.');
    return { x, y, what: '' };
  }

  private async releaseActive(reason: string): Promise<void> {
    const s = this.active;
    if (!s) return;
    this.active = null;
    try {
      await this.hub.deleteSession(s.sessionId);
      this.opts.log(`mfarm mcp: released ${s.sessionId} (${reason})`);
    } catch (err) {
      // The hub's idle sweep collects it, but say so: a device silently still held is billed.
      this.opts.log(`mfarm mcp: could not release ${s.sessionId}: ${describe(err)} — the farm reclaims it when idle`);
    }
  }
}

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}

function text(t: string): ToolResult {
  return { content: [{ type: 'text', text: t }] };
}

function errorResult(err: unknown): ToolResult {
  const msg = err instanceof HubError ? `${err.code}: ${err.message}` : describe(err);
  return { content: [{ type: 'text', text: msg }], isError: true };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
