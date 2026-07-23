/**
 * Detached HOST launched from an IMMUTABLE staged image (seq 1248).
 *
 * A staged image's generated shim (`<imageDir>/entrypoint.mjs`) re-enters this
 * runtime with the tag + protocol version it baked in. The runtime resolves its
 * own image, proves it is running THAT image's entrypoint (never another's),
 * owns exactly one interactive shell via Bun.Terminal, and serves a loopback
 * WebSocket guarded by a per-run token. The hello/version boundary answers at
 * the image's protocol version (`evaluateHelloAtVersion`), so a client speaking
 * a different version gets one explicit `version-mismatch` and only that socket
 * closes — the host, shell, pane, and shell state stay alive.
 *
 * Bun runtime only (never imported by a vitest test). NO tmux involvement.
 */

import { randomBytes } from "node:crypto";
import { spawn } from "../../spawn";
import { assertNativeTerminalRuntime, nativeTerminalSpawnError, sameNativeTerminalPath } from "../../../shared/native-terminal-runtime";
import { exceedsControlFrameLimit } from "../protocol";
import { isPathInside, readStagedImage } from "./staging";
import {
	writeHostSessionRecord,
	writeHostSessionToken,
	recordPath,
	tokenPath,
	type HostSessionRecord,
} from "./session-record";
import { evaluateHelloAtVersion, versionedError, versionedWelcome } from "./version-skew";
import { unlinkSync } from "node:fs";

export interface RunStagedHostOptions {
	expectedTag: string;
	expectedProtocolVersion: number;
}

const STATE_MARKER_ENV = "DEV3_HIMG_STATE";
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required to run a staged host image`);
	return value;
}

function interactiveShellCommand(): string[] {
	if (process.platform === "win32") {
		const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
		return [`${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, "-NoLogo", "-NoProfile"];
	}
	return ["/bin/bash", "--norc", "--noprofile"];
}

/** Entrypoint the generated image shim calls. Boots the host and never returns until stop/exit. */
export async function runStagedHost(options: RunStagedHostOptions): Promise<void> {
	const bunVersion = Bun.version;
	assertNativeTerminalRuntime({ platform: process.platform, bunVersion });

	const root = requireEnv("DEV3_HIMG_ROOT");
	const sessionId = requireEnv("DEV3_HIMG_SESSION_ID");
	const stateDir = requireEnv("DEV3_HIMG_STATE_DIR");
	const stateMarker = process.env.DEV3_HIMG_MARKER ?? randomBytes(6).toString("hex");
	const requestedPort = Number(process.env.DEV3_HIMG_PORT ?? 0) || 0;

	const image = readStagedImage(root, options.expectedTag);
	if (image.status !== "ok") {
		throw new Error(`staged image ${options.expectedTag} is not usable (${image.status}): ${"reason" in image ? image.reason : ""}`);
	}
	if (image.manifest.protocolVersion !== options.expectedProtocolVersion) {
		throw new Error(
			`staged image ${options.expectedTag} manifest protocol v${image.manifest.protocolVersion} != shim-baked v${options.expectedProtocolVersion}`,
		);
	}
	// The running host MUST be executing its own image's immutable entrypoint —
	// never another image's file (proves no in-place executable replacement).
	const entrypoint = process.argv[1];
	if (!sameNativeTerminalPath(entrypoint, image.entrypointPath) && !isPathInside(image.imageDir, entrypoint)) {
		throw new Error(`staged host re-entered ${entrypoint}; expected the ${options.expectedTag} image entrypoint ${image.entrypointPath}`);
	}

	const protocolVersion = image.manifest.protocolVersion;
	const paneId = `${sessionId}:0`;
	const token = randomBytes(24).toString("hex");

	type ClientData = { helloDone: boolean };
	type HostClient = Bun.ServerWebSocket<ClientData>;
	const clients = new Set<HostClient>();
	let shuttingDown = false;

	const proc = (() => {
		try {
			return spawn(interactiveShellCommand(), {
				terminal: {
					cols: 80,
					rows: 24,
					data(_terminal: unknown, bytes: Uint8Array) {
						for (const client of clients) {
							if (!client.data.helloDone) continue;
							try {
								client.send(bytes);
							} catch {
								// dead client — dropped on next close
							}
						}
					},
				},
				cwd: root,
				env: { ...process.env, TERM: "xterm-256color", [STATE_MARKER_ENV]: stateMarker },
			});
		} catch (cause) {
			throw nativeTerminalSpawnError({ platform: process.platform, bunVersion, command: interactiveShellCommand()[0], cause });
		}
	})();
	if (!proc.terminal) {
		try {
			proc.kill();
		} catch {
			// already exited
		}
		throw nativeTerminalSpawnError({
			platform: process.platform,
			bunVersion,
			command: interactiveShellCommand()[0],
			cause: new Error("Bun.spawn returned without a terminal handle"),
		});
	}

	const shellPid = proc.pid;
	const startedAt = new Date().toISOString();

	const server = Bun.serve<ClientData>({
		port: requestedPort,
		hostname: "127.0.0.1",
		fetch(req, srv) {
			const url = new URL(req.url);
			if (url.searchParams.get("token") !== token) return new Response("unauthorized", { status: 401 });
			if (srv.upgrade(req, { data: { helloDone: false } })) return undefined;
			return new Response("dev3 staged host image", { status: 200 });
		},
		websocket: {
			open(ws) {
				clients.add(ws);
			},
			close(ws) {
				clients.delete(ws);
			},
			message(ws, message) {
				try {
					handleFrame(ws, message);
				} catch (err) {
					try {
						ws.send(JSON.stringify(versionedError(protocolVersion, "internal-error", undefined, err instanceof Error ? err.message : String(err))));
					} catch {
						// dead client
					}
				}
			},
		},
	});

	function handleFrame(ws: HostClient, message: string | Uint8Array): void {
		if (typeof message === "string") {
			if (exceedsControlFrameLimit(message)) {
				ws.send(JSON.stringify(versionedError(protocolVersion, "bad-request", undefined, "control frame too large")));
				return;
			}
			if (!ws.data.helloDone) {
				const verdict = evaluateHelloAtVersion(message, sessionId, protocolVersion);
				if (!verdict.ok) {
					ws.send(JSON.stringify(verdict.error));
					ws.close(); // close ONLY this socket — host + shell + other clients stay alive
					return;
				}
				ws.data.helloDone = true;
				ws.send(JSON.stringify(versionedWelcome(protocolVersion, verdict.id, sessionId)));
				return;
			}
			const control = parseControl(message);
			if (!control) return;
			if (control.type === "status" && typeof control.id === "number") {
				ws.send(
					JSON.stringify({
						v: protocolVersion,
						type: "status",
						id: control.id,
						sessionId,
						paneId,
						imageTag: options.expectedTag,
						protocolVersion,
						hostPid: process.pid,
						shellPid,
						alive: proc.terminal ? !proc.terminal.closed : false,
						startedAt,
					}),
				);
			} else if (control.type === "stop") {
				for (const client of clients) {
					try {
						client.send(JSON.stringify({ v: protocolVersion, type: "stopping" }));
					} catch {
						// dead client
					}
				}
				void shutdown(0);
			}
			return;
		}
		if (!ws.data.helloDone) return;
		proc.terminal?.write(message);
	}

	function parseControl(text: string): { type: string; id?: number } | null {
		try {
			const obj = JSON.parse(text) as Record<string, unknown>;
			if (typeof obj.type !== "string") return null;
			return { type: obj.type, id: typeof obj.id === "number" ? obj.id : undefined };
		} catch {
			return null;
		}
	}

	function removeState(): void {
		for (const file of [recordPath(stateDir), tokenPath(stateDir)]) {
			try {
				unlinkSync(file);
			} catch {
				// already gone
			}
		}
	}

	async function shutdown(exitCode: number): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		try {
			server.stop(true);
		} catch {
			// already stopped
		}
		try {
			proc.terminal?.write("\x03");
			await delay(50);
			proc.terminal?.write("exit\r");
		} catch {
			// terminal already closed
		}
		const exited = await Promise.race([proc.exited.then(() => true), delay(1200).then(() => false)]);
		if (!exited) {
			try {
				proc.kill();
			} catch {
				// already gone
			}
			await Promise.race([proc.exited, delay(800)]);
		}
		try {
			proc.terminal?.close();
		} catch {
			// already closed
		}
		removeState();
		process.exit(exitCode);
	}

	void proc.exited.then((code) => {
		if (shuttingDown) return;
		for (const client of clients) {
			try {
				client.send(JSON.stringify({ v: protocolVersion, type: "exit", code }));
			} catch {
				// dead client
			}
		}
		void shutdown(0);
	});

	for (const sig of ["SIGTERM", "SIGINT"] as const) {
		process.on(sig, () => void shutdown(0));
	}

	const record: HostSessionRecord = {
		schema: 1,
		sessionId,
		paneId,
		imageTag: options.expectedTag,
		protocolVersion,
		entrypoint,
		hostPid: process.pid,
		shellPid,
		endpoint: { address: "127.0.0.1", port: server.port ?? 0 },
		stateMarker,
		startedAt,
	};
	// Token first, record last: a reader that sees the record can always read the token.
	writeHostSessionToken(stateDir, token);
	writeHostSessionRecord(stateDir, record);
}
