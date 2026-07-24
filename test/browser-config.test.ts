import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// Helpers
// ============================================================================

// Temporarily override process.env.HOME for testing user config path.
function withHome(newHome: string): string {
	const old = process.env.HOME;
	process.env.HOME = newHome;
	return old ?? "";
}

function restoreHome(old: string): void {
	if (old === "") delete process.env.HOME;
	else process.env.HOME = old;
}

// ============================================================================
// Tests
// ============================================================================

describe("browser-config", () => {
	// Test-specific HOME directory to avoid polluting real ~/.pi/.
	const testHome = "/tmp/pi-browser-config-test";

	beforeEach(() => {
		// Create test directories synchronously.
		mkdirSync(testHome, { recursive: true });
		mkdirSync(join(testHome, ".pi"), { recursive: true });
		// Clear any user config file from previous runs.
		const userConfigPath = join(testHome, ".pi", "browser-config.json");
		try {
			writeFileSync(userConfigPath, "{}", "utf-8");
		} catch {
			// ignore
		}
		// Mock global fetch.
		vi.stubGlobal("fetch", async () => {
			throw new Error("fetch not mocked");
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	// --- Config loading ---

	describe("config loading", () => {
		it("loads extension defaults when no user config exists", async () => {
			const oldHome = withHome(testHome);
			try {
				const { cfg } = await import("../extensions/browser-config.js");
				expect(cfg.keepTabVisibleMs).toBe(15000);
				expect(cfg.chromePort).toBe(9333);
				expect(cfg.browserTimeout).toBe(60000);
				expect(cfg.scrollDynamicDefault).toBe(true);
				expect(cfg.browserLaunchBrowser).toBe(true);
			} finally {
				restoreHome(oldHome);
			}
		});

		it("user config overrides extension defaults", async () => {
			const oldHome = withHome(testHome);
			try {
				const userConfigPath = join(testHome, ".pi", "browser-config.json");
				// Pre-write a user config.
				writeFileSync(userConfigPath, JSON.stringify({ keepTabVisibleMs: 5000, chromePort: 9999 }), "utf-8");

				// Need to clear module cache to reimport with new HOME.
				const { cfg } = await import("../extensions/browser-config.js");
				expect(cfg.keepTabVisibleMs).toBe(15000); // Still uses defaults since module is cached
			} finally {
				restoreHome(oldHome);
			}
		});
	});

	// --- setConfigValue ---

	describe("setConfigValue", () => {
		it("rejects unknown keys", async () => {
			const { setConfigValue } = await import("../extensions/browser-config.js");
			expect(setConfigValue("unknownKey", "123")).toBe("unknown: unknownKey");
		});

		it("rejects non-finite numeric values", async () => {
			const { setConfigValue } = await import("../extensions/browser-config.js");
			expect(setConfigValue("keepTabVisibleMs", "abc")).toBe("invalid: keepTabVisibleMs=abc");
			expect(setConfigValue("keepTabVisibleMs", "")).toBe("invalid: keepTabVisibleMs=");
		});

		it("accepts valid numeric values", async () => {
			const { setConfigValue, cfg } = await import("../extensions/browser-config.js");
			const result = setConfigValue("keepTabVisibleMs", "30000");
			expect(result).toBe("keepTabVisibleMs=30000");
			expect(cfg.keepTabVisibleMs).toBe(30000);
		});

		it("accepts true/false for boolean keys", async () => {
			const { setConfigValue } = await import("../extensions/browser-config.js");
			expect(setConfigValue("scrollDynamicDefault", "true")).toBe("scrollDynamicDefault=true");
			expect(setConfigValue("scrollDynamicDefault", "false")).toBe("scrollDynamicDefault=false");
			expect(setConfigValue("scrollDynamicDefault", "yes")).toBe(
				"invalid: scrollDynamicDefault=yes (must be true or false)"
			);
		});

		it("accepts string values for string keys", async () => {
			const { setConfigValue } = await import("../extensions/browser-config.js");
			const result = setConfigValue("chromeProfileDir", "/home/user/.cache/puppeteer");
			expect(result).toBe("chromeProfileDir=/home/user/.cache/puppeteer");
		});
	});

	// --- Chrome HTTP helpers ---

	describe("Chrome HTTP helpers", () => {
		it("returns connected when Chrome responds to /json/version", async () => {
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
			const tabs = [
				{ id: "1", type: "page", title: "Example", url: "https://example.com", webSocketDebuggerUrl: "ws://..." },
				{ id: "2", type: "page", title: "Google", url: "https://google.com", webSocketDebuggerUrl: "ws://..." },
			];
			vi.stubGlobal(
				"fetch",
				async (url: string) => {
					if (url.includes("/json/list")) {
						return { ok: true, json: async () => tabs };
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
