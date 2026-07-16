import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { BUILD_VERSION } from "../shared/build-info.generated";
import { REMOTE_PROTOCOL_VERSION, type RemoteInstanceInfo } from "../shared/remote-protocol";
import { DEV3_HOME } from "./paths";

export const REMOTE_INSTANCE_ID_FILE = join(DEV3_HOME, "remote-instance-id");

let memoryFallbackId: string | null = null;

function readValidInstanceId(path: string): string | null {
	try {
		if (!existsSync(path)) return null;
		const value = readFileSync(path, "utf8").trim();
		return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
			? value.toLowerCase()
			: null;
	} catch {
		return null;
	}
}

/**
 * Return the stable identity advertised by this dev3 installation.
 *
 * The file is additive under `~/.dev3.0`; it is never renamed or moved. A
 * corrupt value is repaired in place. When persistence is unavailable, auth
 * and remote access remain usable with a process-stable fallback identity.
 */
export function getOrCreateRemoteInstanceId(path: string = REMOTE_INSTANCE_ID_FILE): string {
	const persisted = readValidInstanceId(path);
	if (persisted) return persisted;

	const candidate = memoryFallbackId ?? crypto.randomUUID();
	try {
		mkdirSync(dirname(path), { recursive: true });
		if (!existsSync(path)) {
			try {
				writeFileSync(path, `${candidate}\n`, { flag: "wx", mode: 0o600 });
			} catch {
				// Another process may have won the create race. Prefer its identity.
				const winner = readValidInstanceId(path);
				if (winner) return winner;
				throw new Error("instance identity create failed");
			}
		} else {
			writeFileSync(path, `${candidate}\n`, { mode: 0o600 });
		}
		return candidate;
	} catch {
		memoryFallbackId = candidate;
		return candidate;
	}
}

export interface RemoteInstanceInfoOptions {
	instanceIdPath?: string;
	name?: string;
	appVersion?: string;
}

export function getRemoteInstanceInfo(options: RemoteInstanceInfoOptions = {}): RemoteInstanceInfo {
	return {
		instanceId: getOrCreateRemoteInstanceId(options.instanceIdPath),
		name: options.name ?? (hostname() || "dev3"),
		appVersion: options.appVersion ?? BUILD_VERSION,
		protocolVersion: REMOTE_PROTOCOL_VERSION,
	};
}

/** Reset process fallback state. Tests only. */
export function _resetRemoteInstanceForTests(): void {
	memoryFallbackId = null;
}
