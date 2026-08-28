/**
 * `cli-socket-server.ts` may reach the RPC handlers only through their BARREL.
 *
 * Every suite that exercises the socket server mocks `../rpc-handlers` — one
 * factory, listing exports by name. A static import of a handler DOMAIN module
 * side-steps that mock and drags the module's own import graph in, which ends at
 * `rpc-handlers/shared` → Electrobun. The whole suite then dies at collect time
 * with `Cannot read properties of undefined (reading 'origin')` from inside
 * Electrobun's Socket.ts, and the failure names none of its tests.
 *
 * This shipped once: importing `conversation-import-handlers` here took three
 * cli-socket suites down. If a handler genuinely cannot go through the barrel,
 * load it lazily inside the command (see `conversationImport`).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(import.meta.dirname, "..", "cli-socket-server.ts"), "utf-8");

/** A static `import … from "./rpc-handlers/<domain>"`, which is what breaks. */
const STATIC_DOMAIN_IMPORT = /^import\s[^;]*?from\s+"\.\/rpc-handlers\/([^"]+)"/gm;

/** Deliberate exceptions, each with the reason it is safe. */
const ALLOWED: Record<string, string> = {
	"tmux-pty": "the socket suites mock this exact path by name, so the graph never loads",
	"shared-pure": "pure helpers with no renderer bridge — that is what the -pure suffix means",
};

function staticDomainImports(source: string): string[] {
	return [...source.matchAll(STATIC_DOMAIN_IMPORT)].map((match) => match[1]);
}

describe("cli-socket-server imports", () => {
	it("flags the shape this guard exists for", () => {
		const before = 'import { conversationImportHandlers } from "./rpc-handlers/conversation-import-handlers";';
		expect(staticDomainImports(before)).toEqual(["conversation-import-handlers"]);
	});

	it("does not read a lazy import as a static one, so the fix is not flagged", () => {
		const after = 'return (await import("./rpc-handlers/conversation-import-handlers")).conversationImportHandlers;';
		expect(staticDomainImports(after)).toEqual([]);
	});

	it("imports no handler domain module the socket suites do not already handle", () => {
		const offenders = staticDomainImports(SOURCE).filter((name) => !(name in ALLOWED));
		expect(offenders, "go through ./rpc-handlers, load it lazily, or add a reasoned allowlist entry").toEqual([]);
	});
});
