import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// Config management
//
// Two-tier config:
//   1. Extension defaults  → ./extensions/browser-config.json (bundled)
//   2. User overrides      → ~/.pi/browser-config.json (user-edited)
//
// User config overrides extension defaults. On first load the extension
// auto-creates a user config file at ~/.pi/browser-config.json from the
// bundled defaults so the user can discover and edit them.
// ============================================================================

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const EXT_CONFIG_PATH = join(EXT_DIR, "browser-config.json");
const USER_CONFIG_DIR = join(process.env.HOME ?? "", ".pi");
const USER_CONFIG_PATH = join(USER_CONFIG_DIR, "browser-config.json");

const CONFIG_VERSION = 1;

// Default values that ship with the extension.
const DEFAULTS: Record<string, number | boolean | string> = {
  keepTabVisibleMs: 15000,
  chromePort: 9333,
  chromeProfileDir: "",
  scrollDynamicDefault: true,
  browserTimeoutMs: 60000,
  browserLaunchBrowser: true,
  maxTimeoutMs: 600_000,
  maxMetadataLength: 30_000,
  CONFIG_VERSION: 1,
};

// All known keys and their types — used for validation and display.
const NUMERIC_KEYS = new Set([
  "keepTabVisibleMs",
  "chromePort",
  "browserTimeoutMs",
  "maxTimeoutMs",
  "maxMetadataLength",
]);
const BOOLEAN_KEYS = new Set([
  "scrollDynamicDefault",
  "browserLaunchBrowser",
]);
const STRING_KEYS = new Set([
  "chromeProfileDir",
]);
const ALL_KEYS = [...NUMERIC_KEYS, ...BOOLEAN_KEYS, ...STRING_KEYS];

// Load extension defaults from bundled JSON (or fall back to inline defaults).
function loadExtensionDefaults(): Record<string, unknown> {
  try {
    if (existsSync(EXT_CONFIG_PATH)) {
      return JSON.parse(readFileSync(EXT_CONFIG_PATH, "utf-8"));
    }
  } catch {
    // ignore — use inline defaults
  }
  return { ...DEFAULTS };
}

// Load user config from ~/.pi/browser-config.json (or null if missing).
function loadUserConfig(): Record<string, unknown> | null {
  try {
    if (existsSync(USER_CONFIG_PATH)) {
      return JSON.parse(readFileSync(USER_CONFIG_PATH, "utf-8"));
    }
  } catch {
    // corrupt file — leave it untouched
  }
  return null;
}

// Merge defaults + user overrides, write user config if missing.
export const cfg: Record<string, number | boolean | string> = (() => {
  const extDefaults = loadExtensionDefaults();
  const userConfig = loadUserConfig();

  // Merge: defaults first, then user overrides.
  const merged = { ...extDefaults, ...(userConfig ?? {}) } as Record<
    string,
    number | boolean | string
  >;

  // Auto-create user config file on first load so the user can discover settings.
  if (!existsSync(USER_CONFIG_PATH)) {
    try {
      writeFileSync(USER_CONFIG_PATH, JSON.stringify(merged, null, 2), "utf-8");
    } catch {
      // best-effort — silent fail
    }
  }

  // Ensure user config file has all known keys (backfill from defaults).
  if (existsSync(USER_CONFIG_PATH)) {
    const needsBackfill = ALL_KEYS.some((k) => !(k in merged));
    if (needsBackfill) {
      for (const key of ALL_KEYS) {
        if (!(key in merged) && key in extDefaults) {
          merged[key] = extDefaults[key]! as number | boolean | string;
        }
      }
      try {
        const toWrite: Record<string, number | boolean | string> = {};
        for (const key of ALL_KEYS) {
          if (key in merged) toWrite[key] = merged[key]!;
        }
        toWrite.CONFIG_VERSION = CONFIG_VERSION;
        writeFileSync(USER_CONFIG_PATH, JSON.stringify(toWrite, null, 2), "utf-8");
      } catch {
        // best-effort
      }
    }
  }

  return merged;
})();

// ============================================================================
// Runtime state (in-memory only, not persisted)
// ============================================================================

let chromeConnected: boolean | null = null;
let chromeUrl: string | null = null;
let lastError: string | null = null;
let lastTool: { name: string; urlOrQuery: string; timestamp: number } | null = null;

// ============================================================================
// Chrome HTTP API helpers
// ============================================================================

interface ChromeTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

async function chromeHttpGet(path: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  try {
    const port = Number(cfg.chromePort) || 9333;
    const url = `http://127.0.0.1:${port}${path}`;
    const res = await fetch(url);
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

export async function checkChromeConnection(): Promise<{ connected: boolean; url?: string }> {
  const result = await chromeHttpGet("/json/version");
  if (!result.ok) return { connected: false };

  const wssUrl = (result.data as Record<string, string>)?.webSocketDebuggerUrl;
  if (wssUrl) return { connected: true, url: wssUrl };
  return { connected: true };
}

export async function listChromeTabs(): Promise<ChromeTarget[]> {
  const result = await chromeHttpGet("/json/list");
  if (!result.ok) return [];
  return (result.data as ChromeTarget[]) || [];
}

export async function closeChromeTab(targetId: string): Promise<{ ok: boolean; error?: string }> {
  const result = await chromeHttpGet(`/json/close/${targetId}`);
  if (!result.ok) {
    return { ok: false, error: `Failed to close tab: ${targetId}` };
  }
  return { ok: true };
}

// ============================================================================
// Set config value (like loop-police's setConfigValue)
// ============================================================================

export function setConfigValue(key: string, val: string): string {
  if (NUMERIC_KEYS.has(key)) {
    const num = Number(val);
    if (val === "" || !Number.isFinite(num)) return `invalid: ${key}=${val}`;
    cfg[key] = num;
    return `${key}=${num}`;
  }
  if (BOOLEAN_KEYS.has(key)) {
    if (val !== "true" && val !== "false") return `invalid: ${key}=${val} (must be true or false)`;
    cfg[key] = val === "true";
    return `${key}=${val === "true"}`;
  }
  if (STRING_KEYS.has(key)) {
    cfg[key] = val;
    return `${key}=${val}`;
  }
  return `unknown: ${key}`;
}

function persistConfig(): void {
  try {
    const toWrite: Record<string, number | boolean | string> = {};
    for (const key of ALL_KEYS) {
      if (key in cfg) toWrite[key] = cfg[key]!;
    }
    toWrite.CONFIG_VERSION = CONFIG_VERSION;
    writeFileSync(USER_CONFIG_PATH, JSON.stringify(toWrite, null, 2), "utf-8");
  } catch {
    // best-effort
  }
}

// ============================================================================
// Extension
// ============================================================================

export default function browserConfigExtension(pi: ExtensionAPI) {
  // Refresh runtime state on load
  (async () => {
    const conn = await checkChromeConnection();
    chromeConnected = conn.connected;
    chromeUrl = conn.url ?? null;
  })();

  pi.registerCommand("browser", {
    description:
      "Manage browser tools: status, tabs, close, set config (no args = status)",
    handler: async (
      args: string,
      ctx: ExtensionCommandContext
    ) => {
      const trimmed = args.trim();

      if (trimmed === "reset") {
        chromeConnected = null;
        chromeUrl = null;
        lastError = null;
        lastTool = null;
        ctx.ui.notify("Browser: state reset", "info");
        return;
      }

      if (trimmed.startsWith("set ")) {
        const kv = trimmed.slice(4).trim();
        const eq = kv.indexOf("=");
        if (eq <= 0) {
          ctx.ui.notify('Browser: use /browser set KEY=VAL', "info");
          return;
        }
        const key = kv.slice(0, eq);
        const val = kv.slice(eq + 1);
        const result = setConfigValue(key, val);
        if (result.startsWith("unknown")) {
          ctx.ui.notify(`Browser: ${result}`, "info");
        } else if (result.startsWith("invalid")) {
          ctx.ui.notify(`Browser: ${result}`, "info");
        } else {
          ctx.ui.notify(`Browser: ${result}`, "info");
          persistConfig();
        }
        return;
      }

      if (trimmed === "tabs") {
        // Show Chrome tabs
        try {
          const tabs = await listChromeTabs();
          if (tabs.length === 0) {
            ctx.ui.notify(
              "Browser: no Chrome tabs found\n\n  Ensure Chrome is running with --remote-debugging-port",
              "info"
            );
            return;
          }
          const lines = [
            `Browser: ${tabs.length} tab(s) open`,
            "",
            ...tabs.map((t, i) =>
              `  ${i}: ${t.title || "(untitled)"} — ${t.url || "(about:blank)"}`
            ),
            "",
            `  Use /browser close [index] or /browser close all to close tab(s)`,
          ].join("\n");
          ctx.ui.notify(lines, "info");
        } catch {
          ctx.ui.notify("Browser: failed to list tabs", "info");
        }
        return;
      }

      if (trimmed.startsWith("close ")) {
        const closeArg = trimmed.slice(6).trim();
        if (closeArg === "all") {
          // Close all tabs
          try {
            const tabs = await listChromeTabs();
            if (tabs.length === 0) {
              ctx.ui.notify("Browser: no tabs to close", "info");
              return;
            }
            const results = await Promise.all(tabs.map((t) => closeChromeTab(t.id)));
            const closed = results.filter((r) => r.ok).length;
            ctx.ui.notify(`Browser: closed ${closed}/${tabs.length} tab(s)`, "info");
          } catch {
            ctx.ui.notify("Browser: failed to close tabs", "info");
          }
          return;
        }

        // Close specific tab by index
        const index = parseInt(closeArg, 10);
        if (isNaN(index) || index < 0) {
          ctx.ui.notify(
            `Browser: invalid tab index "${closeArg}", use a number or "all"`,
            "info"
          );
          return;
        }

        try {
          const tabs = await listChromeTabs();
          if (index >= tabs.length) {
            ctx.ui.notify(
              `Browser: only ${tabs.length} tab(s) open, index ${index} out of range`,
              "info"
            );
            return;
          }
          const tab = tabs[index]!;
          await closeChromeTab(tab.id);
          ctx.ui.notify(`Browser: closed "${tab.title || tab.url}"`, "info");
        } catch {
          ctx.ui.notify("Browser: failed to close tab", "info");
        }
        return;
      }

      // No args — show status
      try {
        const conn = await checkChromeConnection();
        chromeConnected = conn.connected;
        chromeUrl = conn.url ?? null;

        const tabs = await listChromeTabs();
        const tabCount = tabs.length;

        const lines = [
          "Browser tools status",
          `  Chrome:     ${chromeConnected ? `connected @ ${chromeUrl}` : "not connected"}`,
          `  Tabs:       ${tabCount} open`,
          `  Last tool:  ${
            lastTool
              ? `${lastTool.name} ${lastTool.urlOrQuery} (${Date.now() - lastTool.timestamp}ms ago)`
              : "none"
          }`,
          "",
          "Config (set KEY=VAL to change):",
          ...ALL_KEYS.map((k) => `  ${k}=${cfg[k]}`),
        ];

        if (lastError) {
          lines.push("", `Last error: ${lastError}`);
        }

        ctx.ui.notify(lines.join("\n"), "info");
      } catch {
        ctx.ui.notify("Browser: failed to get status", "info");
      }
    },
  });
}
