import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { devServerPortEnvKey } from "../shared/dev-servers";
import { createLogger } from "./logger";
import { withFileLock, FileLockTimeoutError } from "./file-lock";
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

/** Read the assignment map straight from disk (no cache). Returns {} if the
 *  file is missing or corrupt. */
function readFromDisk(): PortAssignmentData {
	try {
		if (existsSync(ASSIGNMENTS_FILE)) {
			return JSON.parse(readFileSync(ASSIGNMENTS_FILE, "utf-8")) as PortAssignmentData;
		}
	} catch (err) {
		log.warn("Failed to load port assignments, starting fresh", { error: String(err) });
	}
	return {};
}

function ensureLoaded(): PortAssignmentData {
	if (assignments !== null) return assignments;
	assignments = readFromDisk();
	log.info("Loaded port assignments", { count: Object.keys(assignments).length });
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
 *
 * An existing assignment is EXTENDED rather than replaced when the count grows:
 * a task's port count grows every time a dev server declares a new named port,
 * and reallocating would move `DEV3_PORT0` out from under a server that is
 * already running on it. A shrunken count keeps the first `count` ports for the
 * same reason and releases the tail.
 */
export async function allocatePorts(taskId: string, count: number): Promise<number[]> {
	if (count <= 0) return [];
	if (count > MAX_PORT_COUNT) {
		throw new Error(`portCount ${count} exceeds maximum ${MAX_PORT_COUNT}`);
	}

	// Serialize the whole read-decide-write section with a cross-process file
	// lock. Without it, two concurrent callers (task variants created in
	// parallel, or a second app instance sharing ~/.dev3.0) each took the
	// assigned-port snapshot before either persisted, and could pick the same
	// OS-free ports — handing two tasks overlapping DEV3_PORT0 values. The lock
	// also lets us refresh from disk inside the critical section so a peer's
	// just-persisted picks are visible here.
	return withFileLock(ASSIGNMENTS_FILE, async () => {
		// Re-read under the lock: the in-memory cache may be stale relative to a
		// peer that allocated while we were waiting for the lock.
		assignments = readFromDisk();
		const data = assignments;

		// Return existing allocation if count matches
		const existing = data[taskId];
		if (existing && existing.length === count) {
			log.info("Returning existing port allocation", { taskId: taskId.slice(0, 8), ports: existing });
			return existing;
		}

		if (existing && existing.length > count) {
			const kept = existing.slice(0, count);
			data[taskId] = kept;
			save();
			log.info("Port allocation shrunk", { taskId: taskId.slice(0, 8), ports: kept, released: existing.slice(count) });
			return kept;
		}

		// Whatever the task already holds stays where it is; only the missing tail
		// is picked. Its ports must not be re-picked for the same task, so they are
		// in the assigned set already (they are in `data`).
		const keep = existing ?? [];
		const assignedPorts = getAllAssignedPorts();
		const allocated: number[] = [...keep];

		// Walk the range with a random starting offset so unrelated allocations
		// tend to start in different regions of the range.
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
	});
}

/** Release ports assigned to a task. Returns the released ports. */
export async function releasePorts(taskId: string): Promise<number[]> {
	// Same critical section as allocatePorts: a peer instance sharing
	// ~/.dev3.0 may have persisted allocations while we waited, and writing
	// back the stale in-memory cache would drop them.
	try {
		return await withFileLock(ASSIGNMENTS_FILE, async () => {
			assignments = readFromDisk();
			const data = assignments;
			const ports = data[taskId];
			if (!ports) return [];

			delete data[taskId];
			save();
			log.info("Ports released", { taskId: taskId.slice(0, 8), ports });
			return ports;
		});
	} catch (err) {
		if (!(err instanceof FileLockTimeoutError)) throw err;
		// Release runs during teardown, which must not stall on a contended lock.
		// The record survives on disk: its ports drop out of the allocatable map
		// until some later release removes them, which costs a few ports out of
		// 10000 and locks nothing at the OS level. Log it by name so a growing
		// port-assignments.json is diagnosable instead of mysterious.
		log.error("Ports left assigned: assignment lock unavailable", { taskId: taskId.slice(0, 8) });
		return [];
	}
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

/**
 * Build env vars dict for allocated ports.
 *
 * `ports` is the POSITIONAL block only (what `portCount` asked for), so
 * `DEV3_PORT0..N` and `DEV3_PORT_COUNT` mean exactly what they always meant even
 * on a task whose dev servers added named ports on top. Named ports travel
 * separately, through {@link buildNamedPortEnv}.
 */
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

/**
 * `DEV3_PORT_<NAME>` for every named port of the task. EVERY dev server of the
 * task receives the whole set, which is what lets the back office call the API
 * without anyone wiring ports by hand.
 */
export function buildNamedPortEnv(named: Record<string, number>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, port] of Object.entries(named)) {
		env[devServerPortEnvKey(name)] = String(port);
	}
	return env;
}

/** Reset in-memory state — for tests only. */
export function _resetState(): void {
	assignments = null;
}
