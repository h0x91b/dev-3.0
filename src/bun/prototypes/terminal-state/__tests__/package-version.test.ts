import { beforeEach, describe, expect, it, vi } from "vitest";

const metadata = vi.hoisted(() => ({ override: false, version: undefined as unknown }));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
			if (metadata.override && String(args[0]).replaceAll("\\", "/").endsWith("ghostty-web/package.json")) {
				return JSON.stringify({ version: metadata.version });
			}
			return fs.readFileSync(...args);
		},
	};
});

const loaders = [
	{
		name: "snapshot probe",
		load: async () => {
			const { GhosttyRendererProbe, GHOSTTY_PARSER_ID } = await import("../ghostty-renderer-probe");
			return { id: GHOSTTY_PARSER_ID, create: () => GhosttyRendererProbe.create({ cols: 20, rows: 3, scrollback: 10 }) };
		},
	},
	{
		name: "native registry",
		load: async () => {
			const { GhosttyLiveParser, LIVE_PARSER_ID } = await import("../../../native-terminal-registry/ghostty-live");
			return { id: LIVE_PARSER_ID, create: () => GhosttyLiveParser.create({ cols: 20, rows: 3, scrollbackLimit: 10 }) };
		},
	},
];

beforeEach(() => {
	vi.resetModules();
	metadata.override = false;
	metadata.version = undefined;
});

for (const loader of loaders) {
	describe(loader.name, () => {
		it("loads the installed repaired package without changing the persisted parser identity", async () => {
			const { id, create } = await loader.load();
			expect(id).toBe("ghostty-web@0.4.0");
			const parser = await create();
			try {
				parser.ingest(new TextEncoder().encode("safe界"));
				expect(parser.inspect(10).screen[0].text).toBe("safe界");
			} finally {
				parser.dispose();
			}
		});

		it.each(["0.4.0", "0.4.1", "0.4.0-dev3.2", undefined])("rejects unreviewed package version %s", async (version) => {
			metadata.override = true;
			metadata.version = version;
			const { create } = await loader.load();
			await expect(create()).rejects.toThrow("requires ghostty-web@0.4.0-dev3.1");
		});
	});
}
