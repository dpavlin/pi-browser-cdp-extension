import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// Helpers
// ============================================================================

// Path to the actual config file (in the extension directory).
const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const configPath = join(EXT_DIR, "..", "extensions", "browser-config.json");

function cleanupConfig(): void {
	try {
		if (existsSync(configPath)) {
			unlinkSync(configPath);
		}
	} catch {
		// ignore
	}
}

// ============================================================================
// Tests
// ============================================================================

describe("browser-config", () => {
	beforeEach(() => {
		cleanupConfig();
		vi.stubGlobal("fetch", async () => {
			throw new Error("fetch not mocked");
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		cleanupConfig();
	});

	// --- Config loading ---

	describe("config loading", () => {
		it("loads defaults when config file is missing", async () => {
			vi.resetModules();
			const { cfg } = await import("../extensions/browser-config.js");
			expect(cfg.keepTabVisibleMs).toBe(15000);
			expect(cfg.chromePort).toBe(9333);
			expect(cfg.browserTimeoutMs).toBe(60000);
			expect(cfg.scrollDynamicDefault).toBe(true);
			expect(cfg.browserLaunchBrowser).toBe(true);
		});

		it("creates config file on first load", async () => {
			vi.resetModules();
			const { cfg } = await import("../extensions/browser-config.js");
			expect(existsSync(configPath)).toBe(true);
			const content = JSON.parse(readFileSync(configPath, "utf-8"));
			expect(content.keepTabVisibleMs).toBe(15000);
			expect(content.chromePort).toBe(9333);
		});

		it("loads descriptions", async () => {
			vi.resetModules();
			const { descriptions } = await import("../extensions/browser-config.js");
			expect(descriptions.keepTabVisibleMs).toBe("Tab visible delay after extraction (Ms).");
			expect(descriptions.chromePort).toBe("Chrome --remote-debugging-port number.");
			expect(descriptions.browserTimeoutMs).toBe("Default timeout for browser_execute snippets (Ms).");
			expect(descriptions.maxTimeoutMs).toBe("Hard cap on execution timeout (Ms).");
			expect(descriptions.maxMetadataLength).toBe("Output truncation threshold (chars).");
			expect(descriptions.CONFIG_VERSION).toBe("Internal version stamp. Do not edit.");
		});

		it("backfills missing keys on extension upgrade", async () => {
			vi.resetModules();
			writeFileSync(configPath, JSON.stringify({
				keepTabVisibleMs: 15000,
				CONFIG_VERSION: 1,
			}), "utf-8");
			const { cfg } = await import("../extensions/browser-config.js");
			expect(cfg.chromePort).toBe(9333);
			expect(cfg.chromeProfileDir).toBe("");
		});
	});

	// --- setConfigValue ---

	describe("setConfigValue", () => {
		it("rejects unknown keys", async () => {
			vi.resetModules();
			const { setConfigValue } = await import("../extensions/browser-config.js");
			expect(setConfigValue("unknownKey", "123")).toBe("unknown: unknownKey");
		});

		it("rejects non-finite numeric values", async () => {
			vi.resetModules();
			const { setConfigValue } = await import("../extensions/browser-config.js");
			expect(setConfigValue("keepTabVisibleMs", "abc")).toBe("invalid: keepTabVisibleMs=abc");
			expect(setConfigValue("keepTabVisibleMs", "")).toBe("invalid: keepTabVisibleMs=");
		});

		it("accepts valid numeric values", async () => {
			vi.resetModules();
			const { setConfigValue, cfg } = await import("../extensions/browser-config.js");
			const result = setConfigValue("keepTabVisibleMs", "30000");
			expect(result).toBe("keepTabVisibleMs=30000");
			expect(cfg.keepTabVisibleMs).toBe(30000);
		});

		it("accepts true/false for boolean keys", async () => {
			vi.resetModules();
			const { setConfigValue } = await import("../extensions/browser-config.js");
			expect(setConfigValue("scrollDynamicDefault", "true")).toBe("scrollDynamicDefault=true");
			expect(setConfigValue("scrollDynamicDefault", "false")).toBe("scrollDynamicDefault=false");
			expect(setConfigValue("scrollDynamicDefault", "yes")).toBe(
				"invalid: scrollDynamicDefault=yes (must be true or false)"
			);
		});

		it("accepts string values for string keys", async () => {
			vi.resetModules();
			const { setConfigValue } = await import("../extensions/browser-config.js");
			const result = setConfigValue("chromeProfileDir", "/home/user/.cache/puppeteer");
			expect(result).toBe("chromeProfileDir=/home/user/.cache/puppeteer");
		});
	});

	// --- Chrome HTTP helpers ---

	describe("Chrome HTTP helpers", () => {
		it("returns connected when Chrome responds to /json/version", async () => {
			vi.resetModules();
			vi.stubGlobal(
				"fetch",
				async (url: string) => {
					if (url.includes("/json/version")) {
						return { ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/1" }) };
					}
					throw new Error("unexpected URL");
				}
			);

			const { checkChromeConnection } = await import("../extensions/browser-config.js");
			const result = await checkChromeConnection();
			expect(result.connected).toBe(true);
			expect(result.url).toBe("ws://127.0.0.1:9333/devtools/browser/1");
		});

		it("returns not connected when Chrome is unreachable", async () => {
			vi.resetModules();
			vi.stubGlobal(
				"fetch",
				async () => {
					throw new Error("connection refused");
				}
			);

			const { checkChromeConnection } = await import("../extensions/browser-config.js");
			const result = await checkChromeConnection();
			expect(result.connected).toBe(false);
		});

		it("lists Chrome tabs", async () => {
			vi.resetModules();
			vi.stubGlobal(
				"fetch",
				async (url: string) => {
					if (url.includes("/json/list")) {
						return { ok: true, json: async () => [
							{ id: "1", type: "page", title: "Example", url: "https://example.com", webSocketDebuggerUrl: "ws://..." },
							{ id: "2", type: "page", title: "Google", url: "https://google.com", webSocketDebuggerUrl: "ws://..." },
						]};
					}
					throw new Error("unexpected URL");
				}
			);

			const { listChromeTabs } = await import("../extensions/browser-config.js");
			const result = await listChromeTabs();
			expect(result).toHaveLength(2);
			expect(result[0]!.url).toBe("https://example.com");
		});

		it("returns empty array when no tabs", async () => {
			vi.resetModules();
			vi.stubGlobal(
				"fetch",
				async (url: string) => {
					if (url.includes("/json/list")) {
						return { ok: true, json: async () => [] };
					}
					throw new Error("unexpected URL");
				}
			);

			const { listChromeTabs } = await import("../extensions/browser-config.js");
			const result = await listChromeTabs();
			expect(result).toHaveLength(0);
		});

		it("closes a Chrome tab", async () => {
			vi.resetModules();
			vi.stubGlobal(
				"fetch",
				async (url: string) => {
					if (url.includes("/json/close/1")) {
						return { ok: true, json: async () => ({}) };
					}
					throw new Error("unexpected URL");
				}
			);

			const { closeChromeTab } = await import("../extensions/browser-config.js");
			const result = await closeChromeTab("1");
			expect(result.ok).toBe(true);
		});

		it("returns error when tab close fails", async () => {
			vi.resetModules();
			vi.stubGlobal(
				"fetch",
				async (url: string) => {
					return { ok: false, json: async () => ({}) };
				}
			);

			const { closeChromeTab } = await import("../extensions/browser-config.js");
			const result = await closeChromeTab("nonexistent");
			expect(result.ok).toBe(false);
		});
	});
});
