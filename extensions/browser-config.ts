import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Config lives next to the extension file: ./extensions/browser-config.json
// Auto-created on first load with inline defaults; travels with the extension.
const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(EXT_DIR, "browser-config.json");

const CONFIG_VERSION = 1;

export const DESCRIPTIONS: Record<string, string> = {
  keepTabVisibleMs: "Tab visible delay after extraction (Ms).",
  chromePort: "Chrome --remote-debugging-port number.",
  chromeProfileDir: "Chrome user-data dir (leave empty for default profile).",
  scrollDynamicDefault: "Auto-scroll pages to trigger lazy loading.",
  browserTimeoutMs: "Default timeout for browser_execute snippets (Ms).",
  browserLaunchBrowser: "Auto-launch Chrome if not running.",
  maxTimeoutMs: "Hard cap on execution timeout (Ms).",
  maxMetadataLength: "Output truncation threshold (chars).",
  CONFIG_VERSION: "Internal version stamp. Do not edit.",
};

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

const NUMERIC_KEYS = new Set(["keepTabVisibleMs", "chromePort", "browserTimeoutMs", "maxTimeoutMs", "maxMetadataLength"]);
const BOOLEAN_KEYS = new Set(["scrollDynamicDefault", "browserLaunchBrowser"]);
const STRING_KEYS = new Set(["chromeProfileDir"]);
const ALL_KEYS = [...NUMERIC_KEYS, ...BOOLEAN_KEYS, ...STRING_KEYS];

export const descriptions: Record<string, string> = DESCRIPTIONS;

const cfg: Record<string, number | boolean | string> = (() => {
  let fromFile: Record<string, unknown> | null = null;
  try {
    if (existsSync(CONFIG_PATH)) fromFile = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    fromFile = null;
  }
  const merged = { ...DEFAULTS, ...(fromFile ?? {}) } as Record<string, number | boolean | string>;
  const stampNeeded = fromFile !== null && fromFile.CONFIG_VERSION !== CONFIG_VERSION;
  merged.CONFIG_VERSION = CONFIG_VERSION;

  const fileExists = existsSync(CONFIG_PATH);
  const backfillNeeded = fromFile !== null && Object.keys(DEFAULTS).some((k) => !(k in fromFile));
  if (!fileExists || backfillNeeded || stampNeeded) {
    try {
      const toWrite: Record<string, number | boolean | string> = {};
      for (const key of ALL_KEYS) {
        if (key in merged) toWrite[key] = merged[key]!;
      }
      writeFileSync(CONFIG_PATH, JSON.stringify(toWrite, null, 2), "utf-8");
    } catch {
      // best-effort
    }
  }
  return merged;
})();

export { cfg };

// ============================================================================
// Runtime state (in-memory only)
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
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { ok: res.ok, status: res.status, data: await res.json() };
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
  if (!result.ok) return { ok: false, error: `Failed to close tab: ${targetId}` };
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
    writeFileSync(CONFIG_PATH, JSON.stringify(toWrite, null, 2), "utf-8");
  } catch {
    // best-effort
  }
}

// ============================================================================
// Extension
// ============================================================================

export default function browserConfigExtension(pi: ExtensionAPI) {
  (async () => {
    const conn = await checkChromeConnection();
    chromeConnected = conn.connected;
    chromeUrl = conn.url ?? null;
  })();

  pi.registerCommand("browser", {
    description: "Manage browser tools: status, tabs, close, set config (no args = status)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
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
          ctx.ui.notify("Browser: use /browser set KEY=VAL", "info");
          return;
        }
        const key = kv.slice(0, eq);
        const val = kv.slice(eq + 1);
        const result = setConfigValue(key, val);
        if (result.startsWith("unknown") || result.startsWith("invalid")) {
          ctx.ui.notify(`Browser: ${result}`, "info");
        } else {
          ctx.ui.notify(`Browser: ${result}`, "info");
          persistConfig();
        }
        return;
      }

      if (trimmed === "tabs") {
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
            ...tabs.map((t, i) => `  ${i}: ${t.title || "(untitled)"} — ${t.url || "(about:blank)"}`),
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

        const index = parseInt(closeArg, 10);
        if (isNaN(index) || index < 0) {
          ctx.ui.notify(`Browser: invalid tab index "${closeArg}", use a number or "all"`, "info");
          return;
        }

        try {
          const tabs = await listChromeTabs();
          if (index >= tabs.length) {
            ctx.ui.notify(`Browser: only ${tabs.length} tab(s) open, index ${index} out of range`, "info");
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
          `  Last tool:  ${lastTool ? `${lastTool.name} ${lastTool.urlOrQuery} (${Date.now() - lastTool.timestamp}ms ago)` : "none"}`,
          "",
          "Config (set KEY=VAL to change):",
          ...ALL_KEYS.map(
            (k) => {
              const value = `  ${k}=${cfg[k]}`;
              const padding = Math.max(30 - value.length, 0);
              return `${value}${" ".repeat(padding)}${descriptions[k] ?? ""}`;
            }
          ),
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
