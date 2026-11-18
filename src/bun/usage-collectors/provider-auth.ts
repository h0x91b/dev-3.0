import { readFileSync } from "node:fs";
import { parseProviderAuthTypes } from "../../shared/agent-billing";

/** Provider → login kind from an OpenCode/pi `auth.json`; only `type` is read, never a credential. */
export function readProviderAuthTypes(path: string): Map<string, string> {
	try { return parseProviderAuthTypes(JSON.parse(readFileSync(path, "utf8"))); }
	catch { return new Map(); }
}
