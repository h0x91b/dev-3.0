/**
 * A FROZEN copy of how dev3 read a native session at 3228bbd — before capture
 * modes existed. It imports nothing from the live modules on purpose: a stand-in
 * that calls today's code proves only that today's code agrees with itself.
 *
 * Update this file only to correct a mistake about what that build did, never to
 * track a change in the current build.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export { n2ParseRecord, type N2SessionRecord } from "./n2-record-parser";

/**
 * That build's ONLY product-reachable capture path: read `parser-state.json`,
 * accept it if schema, version and parser identity match, and render the screen
 * as text. `null` means "nothing to show" — which is what it returned for every
 * session whose host ran no parser, i.e. every production pane.
 */
export function n2CaptureText(sessionDir: string, sessionId: string, includeHistory: boolean): string | null {
	const file = join(sessionDir, "parser-state.json");
	if (!existsSync(file)) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (r.schema !== "dev3-native-session-parser-state" || r.version !== 1) return null;
	if (r.parser !== "ghostty-web@0.4.0" || r.sessionId !== sessionId) return null;
	const state = r.state as Record<string, unknown> | null;
	if (!state) return null;
	const lineText = (lines: unknown): string[] =>
		Array.isArray(lines) ? lines.map((line) => String((line as { text?: unknown })?.text ?? "")) : [];
	const rows = includeHistory
		? [...lineText(state.scrollback), ...lineText(state.screen)]
		: lineText(state.screen);
	let end = rows.length;
	while (end > 0 && rows[end - 1]!.trim() === "") end--;
	return rows.slice(0, end).join("\n");
}
