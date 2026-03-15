import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";

const log = createLogger("port-pool");

// Port range dedicated to dev-3.0 worktrees.
const PORT_RANGE_START = 10000;
const PORT_RANGE_END = 20000;
const MAX_PORT_COUNT = 20;

const ASSIGNMENTS_FILE = `${DEV3_HOME}/port-assignments.json`;

/** Persisted port assignment map: taskId → number[] */
interface PortAssignmentData {
	[taskId: string]: number[];
}

let assignments: PortAssignmentData | null = null;

function ensureLoaded(): PortAssignmentData {
	if (assignments !== null) return assignments;
	try {
		if (existsSync(ASSIGNMENTS_FILE)) {
			const raw = readFileSync(ASSIGNMENTS_FILE, "utf-8");
			assignments = JSON.parse(raw) as PortAssignmentData;
			log.info("Loaded port assignments", { count: Object.keys(assignments).length });
		} else {
			assignments = {};
		}
	} catch (err) {
		log.warn("Failed to load port assignments, starting fresh", { error: String(err) });
		assignments = {};
	}
	return assignments;
}

function save(): void {
	try {
		mkdirSync(DEV3_HOME, { recursive: true });
		writeFileSync(ASSIGNMENTS_FILE, JSON.stringify(assignments, null, 2) + "\n");
	} catch (err) {
		log.error("Failed to save port assignments", { error: String(err) });
	}
}

/** Check if a TCP port is available by attempting to bind to it. */
async function isPortFree(port: number): Promise<boolean> {
	// Check TCP
	const tcpFree = await new Promise<boolean>((resolve) => {
		const server = createServer();
		server.once("error", () => {
			server.close();
			resolve(false);
		});
		server.listen(port, "127.0.0.1", () => {
			server.close(() => resolve(true));
		});
	});

	if (!tcpFree) return false;

	// Check UDP too
	const udpFree = await new Promise<boolean>((resolve) => {
		const socket = createSocket("udp4");
		socket.once("error", () => {
			socket.close();
			resolve(false);
		});
		socket.bind(port, "127.0.0.1", () => {
			socket.close(() => resolve(true));
		});
	});

	return udpFree;
}

/** Get set of all ports currently assigned to any task. */
function getAllAssignedPorts(): Set<number> {
	const data = ensureLoaded();
	const ports = new Set<number>();
	for (const taskPorts of Object.values(data)) {
		for (const p of taskPorts) {
			ports.add(p);
		}
	}
	return ports;
}

/**
 * Allocate `count` free ports for a task. Returns the assigned ports.
 * If the task already has ports allocated, returns existing ones
 * (re-allocates only if the count changed).
 */
export async function allocatePorts(taskId: string, count: number): Promise<number[]> {
	if (count <= 0) return [];
	if (count > MAX_PORT_COUNT) {
		throw new Error(`portCount ${count} exceeds maximum ${MAX_PORT_COUNT}`);
	}

	const data = ensureLoaded();

	// Return existing allocation if count matches
	const existing = data[taskId];
	if (existing && existing.length === count) {
		log.info("Returning existing port allocation", { taskId: taskId.slice(0, 8), ports: existing });
		return existing;
	}

	// Release old allocation if count changed
	if (existing) {
		delete data[taskId];
	}

	const assignedPorts = getAllAssignedPorts();
	const allocated: number[] = [];

	// Walk the range with a random starting offset to reduce collisions
	// between concurrent allocations.
	const rangeSize = PORT_RANGE_END - PORT_RANGE_START;
	const startOffset = Math.floor(Math.random() * rangeSize);

	for (let i = 0; i < rangeSize && allocated.length < count; i++) {
		const port = PORT_RANGE_START + ((startOffset + i) % rangeSize);

		// Skip ports already assigned to other tasks
		if (assignedPorts.has(port)) continue;

		// Verify the port is free at the OS level
		const free = await isPortFree(port);
		if (free) {
			allocated.push(port);
			assignedPorts.add(port); // prevent double-pick within this loop
		}
	}

	if (allocated.length < count) {
		throw new Error(
			`Could not allocate ${count} free ports (only found ${allocated.length}). ` +
			`Range ${PORT_RANGE_START}-${PORT_RANGE_END} may be exhausted.`,
		);
	}

	data[taskId] = allocated;
	save();
	log.info("Ports allocated", { taskId: taskId.slice(0, 8), ports: allocated });
	return allocated;
}

/** Release ports assigned to a task. Returns the released ports. */
export function releasePorts(taskId: string): number[] {
	const data = ensureLoaded();
	const ports = data[taskId];
	if (!ports) return [];

	delete data[taskId];
	save();
	log.info("Ports released", { taskId: taskId.slice(0, 8), ports });
	return ports;
}

/** Get ports currently assigned to a task (without allocating). */
export function getPortAssignments(taskId: string): number[] {
	const data = ensureLoaded();
	return data[taskId] ?? [];
}

/** Get all current port assignments. */
export function getAllAssignments(): PortAssignmentData {
	return { ...ensureLoaded() };
}

/** Build env vars dict for allocated ports. */
export function buildPortEnv(ports: number[]): Record<string, string> {
	if (ports.length === 0) return {};

	const env: Record<string, string> = {
		DEV3_PORT_COUNT: String(ports.length),
		DEV3_PORTS: ports.join(","),
	};
	for (let i = 0; i < ports.length; i++) {
		env[`DEV3_PORT${i}`] = String(ports[i]);
	}
	return env;
}

/** Reset in-memory state — for tests only. */
export function _resetState(): void {
	assignments = null;
}
