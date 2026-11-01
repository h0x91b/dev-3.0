import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const DEV3_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/extensions-host`);
const SOURCE = `${DEV3_HOME}-source`;

vi.mock("../paths", () => ({ DEV3_HOME, OPS_DIR: `${DEV3_HOME}/ops` }));
vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

import { getExtensionsOverview, readExtensionSource } from "../extensions";
import { extensionsHandlers } from "../rpc-handlers/extensions";
import { runAsRemoteRpc } from "../rpc-origin";

const BUNDLE = "export default { name: 'x', apply() {} };";

function writeExtension(dir: string, manifest: Record<string, unknown>, bundle: string | null = BUNDLE): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(`${dir}/dev3-extension.json`, JSON.stringify(manifest));
	if (bundle !== null) writeFileSync(`${dir}/index.js`, bundle);
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "focus-list",
		name: "Focus list",
		version: "1.0.0",
		publisher: "Someone",
		engines: { dev3: "^1.0.0" },
		contributes: { boardViews: [{ id: "focus", label: "Focus list" }] },
		...overrides,
	};
}

beforeEach(() => {
	for (const dir of [DEV3_HOME, SOURCE]) rmSync(dir, { recursive: true, force: true });
	mkdirSync(DEV3_HOME, { recursive: true });
	delete process.env.DEV3_EXTENSIONS;
});

describe("extensions on disk", () => {
	it("lists nothing, and writes nothing, when the directory does not exist", async () => {
		const overview = await getExtensionsOverview();
		expect(overview).toMatchObject({ enabled: true, lockedBy: null, extensions: [] });
		expect(existsSync(`${DEV3_HOME}/extensions`)).toBe(false);
		expect(existsSync(`${DEV3_HOME}/extensions-state.json`)).toBe(false);
	});

	it("refuses to install without consent, then copies only the two files and records trust", async () => {
		writeExtension(SOURCE, manifest());
		writeFileSync(`${SOURCE}/postinstall.sh`, "rm -rf /");
		await expect(extensionsHandlers.installExtension({ path: SOURCE, consent: false })).rejects.toThrow(/consent/);
		expect(existsSync(`${DEV3_HOME}/extensions/focus-list`)).toBe(false);

		const installed = await extensionsHandlers.installExtension({ path: SOURCE, consent: true });
		expect(installed.status).toBe("active");
		expect(readFileSync(`${DEV3_HOME}/extensions/focus-list/index.js`, "utf8")).toBe(BUNDLE);
		expect(existsSync(`${DEV3_HOME}/extensions/focus-list/postinstall.sh`)).toBe(false);
		const state = JSON.parse(readFileSync(`${DEV3_HOME}/extensions-state.json`, "utf8"));
		expect(state.trust["focus-list"].publisher).toBe("Someone");
	});

	it("asks for consent only on first install, and again when the publisher changes", async () => {
		writeExtension(SOURCE, manifest());
		await extensionsHandlers.installExtension({ path: SOURCE, consent: true });
		writeExtension(SOURCE, manifest({ version: "1.1.0" }));
		expect((await extensionsHandlers.inspectExtension({ path: SOURCE })).alreadyTrusted).toBe(true);
		await expect(extensionsHandlers.installExtension({ path: SOURCE, consent: false })).resolves.toMatchObject({ status: "active" });
		writeExtension(SOURCE, manifest({ publisher: "Someone else" }));
		expect((await extensionsHandlers.inspectExtension({ path: SOURCE })).alreadyTrusted).toBe(false);
		await expect(extensionsHandlers.installExtension({ path: SOURCE, consent: false })).rejects.toThrow(/consent/);
	});

	it("marks a folder copied in by hand as untrusted and never serves its code", async () => {
		writeExtension(`${DEV3_HOME}/extensions/focus-list`, manifest());
		const overview = await getExtensionsOverview();
		expect(overview.extensions).toMatchObject([{ id: "focus-list", status: "untrusted" }]);
		await expect(readExtensionSource("focus-list")).rejects.toThrow(/not active/);
		await extensionsHandlers.trustExtension({ id: "focus-list" });
		await expect(readExtensionSource("focus-list")).resolves.toBe(BUNDLE);
	});

	it("marks an engines.dev3 mismatch incompatible and keeps it off", async () => {
		writeExtension(SOURCE, manifest({ engines: { dev3: "^2.0.0" } }));
		const inspection = await extensionsHandlers.inspectExtension({ path: SOURCE });
		expect(inspection.compatible).toBe(false);
		const installed = await extensionsHandlers.installExtension({ path: SOURCE, consent: true });
		expect(installed).toMatchObject({ status: "incompatible" });
		expect(installed.problem).toMatch(/\^2\.0\.0/);
		await expect(readExtensionSource("focus-list")).rejects.toThrow(/not active/);
	});

	it("reports a broken folder as invalid without reading its bundle", async () => {
		writeExtension(`${DEV3_HOME}/extensions/focus-list`, manifest(), null);
		writeExtension(`${DEV3_HOME}/extensions/mismatch`, manifest());
		const { extensions } = await getExtensionsOverview();
		expect(extensions).toEqual([
			{ id: "focus-list", manifest: null, status: "invalid", problem: "index.js is missing" },
			expect.objectContaining({ id: "mismatch", status: "invalid", problem: expect.stringMatching(/does not match/) }),
		]);
	});

	it("serves no extension code while the kill switch or DEV3_EXTENSIONS=off is on", async () => {
		writeExtension(SOURCE, manifest());
		await extensionsHandlers.installExtension({ path: SOURCE, consent: true });
		await extensionsHandlers.setExtensionsEnabled({ enabled: false });
		await expect(readExtensionSource("focus-list")).rejects.toThrow(/turned off/);
		await extensionsHandlers.setExtensionsEnabled({ enabled: true });
		process.env.DEV3_EXTENSIONS = "off";
		const overview = await getExtensionsOverview();
		expect(overview).toMatchObject({ enabled: false, enabledSetting: true, lockedBy: "env" });
		await expect(readExtensionSource("focus-list")).rejects.toThrow(/turned off/);
	});

	it("removes only the extension's own folder and its records", async () => {
		writeExtension(SOURCE, manifest());
		await extensionsHandlers.installExtension({ path: SOURCE, consent: true });
		await extensionsHandlers.uninstallExtension({ id: "focus-list" });
		expect(existsSync(`${DEV3_HOME}/extensions/focus-list`)).toBe(false);
		expect(existsSync(`${DEV3_HOME}/extensions`)).toBe(true);
		await expect(extensionsHandlers.uninstallExtension({ id: "../data" })).rejects.toThrow(/Invalid extension id/);
	});

	it("never lets Kanban be disabled", async () => {
		await expect(extensionsHandlers.setBuiltinBoardViewEnabled({ viewId: "builtin:kanban", enabled: false })).rejects.toThrow();
		await extensionsHandlers.setBuiltinBoardViewEnabled({ viewId: "builtin:table", enabled: false });
		expect((await getExtensionsOverview()).disabledBuiltins).toEqual(["builtin:table"]);
	});
});

describe("remote sessions (D12)", () => {
	it("cannot install, trust, enable or remove anything", async () => {
		writeExtension(SOURCE, manifest());
		const remote = <T>(fn: () => Promise<T>) => runAsRemoteRpc(fn);
		await expect(remote(() => extensionsHandlers.inspectExtension({ path: SOURCE }))).rejects.toThrow(/desktop app only/);
		await expect(remote(() => extensionsHandlers.installExtension({ path: SOURCE, consent: true }))).rejects.toThrow(/desktop app only/);
		await expect(remote(() => extensionsHandlers.trustExtension({ id: "focus-list" }))).rejects.toThrow(/desktop app only/);
		await expect(remote(() => extensionsHandlers.setExtensionEnabled({ id: "focus-list", enabled: true }))).rejects.toThrow(/desktop app only/);
		await expect(remote(() => extensionsHandlers.setBuiltinBoardViewEnabled({ viewId: "builtin:table", enabled: true }))).rejects.toThrow(/desktop app only/);
		await expect(remote(() => extensionsHandlers.uninstallExtension({ id: "focus-list" }))).rejects.toThrow(/desktop app only/);
		expect(existsSync(`${DEV3_HOME}/extensions`)).toBe(false);
	});

	it("may switch extensions off, but not back on", async () => {
		await runAsRemoteRpc(() => extensionsHandlers.setExtensionsEnabled({ enabled: false }));
		expect((await getExtensionsOverview()).enabled).toBe(false);
		await expect(runAsRemoteRpc(() => extensionsHandlers.setExtensionsEnabled({ enabled: true }))).rejects.toThrow(/desktop app only/);
		expect((await getExtensionsOverview()).enabled).toBe(false);
	});
});
