#!/usr/bin/env bun
/**
 * Real-transport proof for the Windows CLI control channel (seq 1296).
 *
 * The vitest suites prove the RULES against an injected bind and mock sockets;
 * this script proves the same rules against the REAL `Bun.listen` loopback
 * listener and the REAL `sendRequest` client — under `bun`, because vitest runs
 * on Node where `Bun.listen` does not exist.
 *
 * Checks: an end-to-end request/response round-trip, two coexisting instances
 * routed by their own records, a stale record, a rejected token, malformed and
 * oversized frames, a mid-request disconnect, and — the network boundary — that
 * the listener answers on 127.0.0.1 and on no other local interface.
 *
 * Run: bun run test:cli-loopback-e2e   (cross-platform; the transport is the
 * Windows carrier but the proof is platform-independent)
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { startCliListener, MAX_CLI_REQUEST_BYTES, type CliListener } from "../cli-listener";
import { sendRequest } from "../../cli/socket-client";
import {
	CLI_ENDPOINT_TOKEN_MISMATCH,
	cliEndpointFileName,
	parseCliEndpointRecord,
	serializeCliEndpointRecord,
	type CliEndpointRecord,
} from "../../shared/cli-endpoint";
import type { CliRequest, CliResponse } from "../../shared/types";

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) console.log(`  ok   - ${message}`);
	else {
		failures++;
		console.error(`  FAIL - ${message}`);
	}
}

const listeners: CliListener[] = [];

function start(socketsDir: string, pid: number, hostTaskId: string | null = null): CliListener {
	const listener = startCliListener({
		socketsDir,
		pid,
		hostTaskId,
		transport: "tcp",
		// Mirrors the real handler contract: `handleRequest` converts a thrown
		// handler error into an `ok: false` response and never rejects.
		handle: async (req: CliRequest): Promise<CliResponse> => {
			if (req.method === "boom") return { id: req.id, ok: false, error: "handler exploded" };
			return { id: req.id, ok: true, data: { echoed: req.method, pid } };
		},
	});
	listeners.push(listener);
	return listener;
}

function record(endpoint: string): CliEndpointRecord {
	const parsed = parseCliEndpointRecord(readFileSync(endpoint, "utf-8"));
	if (!parsed) throw new Error(`endpoint record did not parse: ${endpoint}`);
	return parsed;
}

/** Raw NDJSON exchange, bypassing the client's guards. */
function sendRaw(host: string, port: number, raw: string, timeoutMs = 5000): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = connect({ host, port });
		const chunks: Buffer[] = [];
		socket.on("connect", () => socket.write(raw));
		socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		socket.on("error", reject);
		socket.setTimeout(timeoutMs, () => {
			socket.destroy();
			reject(new Error("raw send timed out"));
		});
	});
}

function firstResponse(raw: string): CliResponse {
	const line = raw.split("\n").find((l) => l.trim());
	if (!line) throw new Error("no response line");
	return JSON.parse(line) as CliResponse;
}

async function errorOf(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
		return new Error("NO_ERROR_THROWN");
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	}
}

async function run(): Promise<void> {
	const socketsDir = mkdtempSync(join(tmpdir(), "dev3-cli-loopback-"));
	try {
		console.log("single instance round-trip");
		const primary = start(socketsDir, 4242);
		check(existsSync(primary.endpoint), "the endpoint record is published after the bind");
		// The listener composes paths with "/" like the rest of the data layer
		// (DEV3_HOME is normalised to forward slashes — see resolveUserHome), so
		// compare that spelling rather than the platform's path.join.
		check(primary.endpoint === `${socketsDir}/${cliEndpointFileName(4242)}`, "the record is named by pid");
		const primaryRecord = record(primary.endpoint);
		check(primaryRecord.host === "127.0.0.1", "the record advertises loopback only");
		check(primaryRecord.port === primary.port && primaryRecord.port > 0, "the record carries the bound ephemeral port");
		check(primaryRecord.token.length === 64, "the record carries a 32-byte token");

		const resp = await sendRequest(primary.endpoint, "current", { brief: true });
		check(resp.ok === true, "sendRequest completes the existing request contract over loopback");
		check((resp.data as { echoed: string }).echoed === "current", "the app receives the method and params");

		console.log("\ncommand failures still reach the client");
		const boom = await sendRequest(primary.endpoint, "boom");
		check(boom.ok === false && String(boom.error).includes("exploded"), "an error response survives the loopback carrier intact");

		console.log("\ntwo coexisting instances");
		const guest = start(socketsDir, 4243, "aabbccdd-1111-2222-3333-444444444444");
		check(guest.port !== primary.port, "the second instance binds a different port");
		check(record(guest.endpoint).token !== primaryRecord.token, "each instance has its own token");
		check(record(guest.endpoint).hostTaskId === "aabbccdd-1111-2222-3333-444444444444", "the guest records its launching task");
		const guestResp = await sendRequest(guest.endpoint, "current");
		check((guestResp.data as { pid: number }).pid === 4243, "each record routes to its own instance");
		const primaryAgain = await sendRequest(primary.endpoint, "current");
		check((primaryAgain.data as { pid: number }).pid === 4242, "the first instance is still reachable");

		console.log("\ntoken enforcement");
		const wrongToken = firstResponse(await sendRaw(primaryRecord.host, primaryRecord.port,
			JSON.stringify({ id: "x", method: "current", params: {}, token: "nope" }) + "\n"));
		check(wrongToken.error === CLI_ENDPOINT_TOKEN_MISMATCH, "a mismatched token is rejected");
		const noToken = firstResponse(await sendRaw(primaryRecord.host, primaryRecord.port,
			JSON.stringify({ id: "x", method: "current", params: {} }) + "\n"));
		check(noToken.error === CLI_ENDPOINT_TOKEN_MISMATCH, "a missing token is rejected");

		console.log("\nframing and bounds");
		const malformed = firstResponse(await sendRaw(primaryRecord.host, primaryRecord.port, "{not json\n"));
		check(String(malformed.error).includes("Invalid JSON in CLI request"), "a malformed frame yields the shared parse error");
		const oversized = firstResponse(await sendRaw(primaryRecord.host, primaryRecord.port, "x".repeat(MAX_CLI_REQUEST_BYTES + 1024) + "\n"));
		check(String(oversized.error).includes("Payload exceeded"), "an oversized frame yields the shared size-bound error");
		const afterAbuse = await sendRequest(primary.endpoint, "current");
		check(afterAbuse.ok === true, "the listener still serves clients after malformed and oversized frames");

		console.log("\nmid-request disconnect");
		await new Promise<void>((resolve, reject) => {
			const socket = connect({ host: primaryRecord.host, port: primaryRecord.port });
			socket.on("connect", () => {
				socket.write(JSON.stringify({ id: "gone", method: "current", params: {}, token: primaryRecord.token }) + "\n");
				socket.destroy();
				resolve();
			});
			socket.on("error", reject);
		});
		const afterDisconnect = await sendRequest(primary.endpoint, "current");
		check(afterDisconnect.ok === true, "a client that vanishes mid-request does not break the listener");

		console.log("\nstale and unusable records");
		const staleEndpoint = join(socketsDir, cliEndpointFileName(4244));
		writeFileSync(staleEndpoint, serializeCliEndpointRecord({ ...primaryRecord, pid: 4244, token: "d".repeat(64) }));
		const staleErr = await errorOf(sendRequest(staleEndpoint, "current"));
		check(staleErr.name === "StaleEndpointError", "a record whose token the live instance rejects reports STALE_ENDPOINT");

		const corruptEndpoint = join(socketsDir, cliEndpointFileName(4245));
		writeFileSync(corruptEndpoint, "{ truncated");
		const corruptErr = await errorOf(sendRequest(corruptEndpoint, "current"));
		check(corruptErr.name === "StaleEndpointError", "a corrupt record reports STALE_ENDPOINT");

		const missingErr = await errorOf(sendRequest(join(socketsDir, cliEndpointFileName(4246)), "current", {}, { connectAttempts: 2, retryDelayMs: 5 }));
		check(missingErr.message === "APP_NOT_RUNNING", "a missing record reports APP_NOT_RUNNING");

		console.log("\napp not running");
		const stoppedPid = 4247;
		const stopped = start(socketsDir, stoppedPid);
		const stoppedEndpoint = stopped.endpoint;
		stopped.stop();
		unlinkSync(stoppedEndpoint);
		const downErr = await errorOf(sendRequest(stoppedEndpoint, "current", {}, { connectAttempts: 2, retryDelayMs: 5 }));
		check(downErr.message === "APP_NOT_RUNNING", "a shut-down instance reports APP_NOT_RUNNING");

		console.log("\nnetwork boundary");
		const external = Object.values(networkInterfaces())
			.flatMap((addresses) => addresses ?? [])
			.filter((address) => address.family === "IPv4" && !address.internal)
			.map((address) => address.address);
		console.log(`  (non-loopback IPv4 interfaces to probe: ${external.length ? external.join(", ") : "none on this machine"})`);
		for (const host of external) {
			const reachErr = await errorOf(sendRaw(host, primaryRecord.port, "\n", 2000));
			check(reachErr.message !== "NO_ERROR_THROWN", `the listener does not answer on ${host}:${primaryRecord.port}`);
		}
		const loopbackStillWorks = await sendRequest(primary.endpoint, "current");
		check(loopbackStillWorks.ok === true, "the same port answers on 127.0.0.1");
	} finally {
		for (const listener of listeners) {
			try { listener.stop(); } catch { /* already stopped */ }
		}
		rmSync(socketsDir, { recursive: true, force: true });
	}
}

run()
	.then(() => {
		if (failures > 0) {
			console.error(`\n${failures} check(s) FAILED`);
			process.exit(1);
		}
		console.log("\nALL CHECKS PASSED");
		process.exit(0);
	})
	.catch((error) => {
		console.error("\nERROR:", error);
		process.exit(1);
	});
