import type { RemoteInstanceInfo } from "../shared/remote-protocol";
import { createLogger } from "./logger";

const log = createLogger("remote-discovery");

export const REMOTE_DISCOVERY_DISABLE_ENV = "DEV3_REMOTE_NO_MDNS";

interface PublishedService {
	on(event: "error", listener: (error: Error) => void): unknown;
	stop(callback?: () => void): unknown;
}

interface BonjourClient {
	publish(options: {
		name: string;
		type: "dev3";
		protocol: "tcp";
		port: number;
		txt: Record<string, string>;
		probe: boolean;
	}): PublishedService;
	destroy(): void;
}

type BonjourConstructor = new (
	options?: Record<string, never>,
	errorCallback?: (error: Error) => void,
) => BonjourClient;
type BonjourLoader = () => Promise<BonjourConstructor>;

export interface RemoteDiscoveryAdvertisement {
	stop(): void;
}

async function loadBonjour(): Promise<BonjourConstructor> {
	const imported = await import("bonjour-service");
	return (imported.default ?? imported) as unknown as BonjourConstructor;
}

export function isRemoteDiscoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[REMOTE_DISCOVERY_DISABLE_ENV] !== "1";
}

function serviceName(info: RemoteInstanceInfo, port: number): string {
	const shortHost = info.name.trim().slice(0, 38) || "dev3";
	return `dev3 ${shortHost} ${info.instanceId.slice(0, 8)} ${port}`;
}

/**
 * Best-effort DNS-SD advertisement for `_dev3._tcp`.
 *
 * Discovery is intentionally outside the server's availability boundary:
 * missing multicast support, denied sockets, package errors, and unsupported
 * networks all degrade to a silent no-op while direct/manual remote access
 * keeps working.
 */
export async function startRemoteDiscoveryAdvertisement(
	info: RemoteInstanceInfo,
	port: number,
	options: { env?: NodeJS.ProcessEnv; loadBonjour?: BonjourLoader } = {},
): Promise<RemoteDiscoveryAdvertisement | null> {
	if (!port || !isRemoteDiscoveryEnabled(options.env)) return null;

	try {
		const Bonjour = await (options.loadBonjour ?? loadBonjour)();
		let stopAfterError: (() => void) | null = null;
		const bonjour = new Bonjour({}, (error) => {
			log.debug("DNS-SD socket stopped after an error", { error: String(error) });
			stopAfterError?.();
		});
		let service: PublishedService;
		try {
			service = bonjour.publish({
				name: serviceName(info, port),
				type: "dev3",
				protocol: "tcp",
				port,
				probe: true,
				txt: {
					instanceId: info.instanceId,
					protocolVersion: String(info.protocolVersion),
					appVersion: info.appVersion,
				},
			});
		} catch (error) {
			try { bonjour.destroy(); } catch { /* best effort */ }
			throw error;
		}

		let stopped = false;
		const stop = (): void => {
			if (stopped) return;
			stopped = true;
			try {
				service.stop(() => {
					try { bonjour.destroy(); } catch { /* best effort */ }
				});
			} catch {
				try { bonjour.destroy(); } catch { /* best effort */ }
			}
		};
		stopAfterError = stop;
		service.on("error", (error) => {
			log.debug("DNS-SD advertisement stopped after an error", { error: String(error) });
			stop();
		});
		return { stop };
	} catch (error) {
		log.debug("DNS-SD advertisement unavailable", { error: String(error) });
		return null;
	}
}
