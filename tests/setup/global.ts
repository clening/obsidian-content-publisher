import { vi } from "vitest";

global.console = {
  ...console,
  log: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  time: vi.fn(),
  timeEnd: vi.fn(),
  group: vi.fn(),
  groupEnd: vi.fn(),
  table: vi.fn(),
};

// Obsidian-injected globals: in real Obsidian they always reflect the currently
// focused window/document (popout-aware). Tests run in jsdom with one window,
// so we point them at the jsdom globals.
// Cast to a loose shape — we just need the runtime members the plugin reads.
const g = globalThis as unknown as { activeWindow?: unknown; activeDocument?: unknown };
g.activeWindow = window;
g.activeDocument = document;
