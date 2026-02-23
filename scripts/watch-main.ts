import { watch, type WatchEventType } from "node:fs";

const WATCH_DIRS = ["src/bun", "src/shared"];
const DEBOUNCE_MS = 2000;
const ELECTROBUN_CMD = ["bunx", "electrobun", "dev"];
const VITE_CMD = ["bunx", "vite", "--port", "5173"];
const VITE_PORT = 5173;
const ELECTROBUN_PORT = 7681;
const PORT_WAIT_TIMEOUT = 10_000;
const PORT_POLL_INTERVAL = 200;

let electrobunProc: ReturnType<typeof Bun.spawn> | null = null;
let viteProc: ReturnType<typeof Bun.spawn> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let restarting = false;
const projectRoot = import.meta.dir + "/..";

const log = (msg: string) =>
	console.log(`\x1b[36m[watch]\x1b[0m ${msg}`);

const warn = (msg: string) =>
	console.log(`\x1b[33m[watch]\x1b[0m ${msg}`);

async function waitForPortFree(port: number): Promise<boolean> {
	const deadline = Date.now() + PORT_WAIT_TIMEOUT;
	while (Date.now() < deadline) {
		try {
			const server = Bun.listen({
				hostname: "127.0.0.1",
				port,
				socket: {
					data() {},
				},
			});
			server.stop(true);
			return true;
		} catch {
			await Bun.sleep(PORT_POLL_INTERVAL);
		}
	}
	return false;
}

function killPortOwner(port: number) {
	// Find and kill any process listening on this port (leftover zombies)
	try {
		const result = Bun.spawnSync(
			["lsof", "-ti", `tcp:${port}`],
			{ cwd: projectRoot },
		);
		const pids = result.stdout.toString().trim();
		if (pids) {
			for (const pid of pids.split("\n")) {
				log(`Killing leftover process ${pid} on port ${port}`);
				try {
					process.kill(Number(pid), "SIGKILL");
				} catch {}
			}
		}
	} catch {}
}

async function freePort(port: number) {
	killPortOwner(port);
	await waitForPortFree(port);
}

async function killProcessTree(proc: ReturnType<typeof Bun.spawn>) {
	const pid = proc.pid;
	// Kill child processes first (best-effort)
	try {
		const result = Bun.spawnSync(["pkill", "-TERM", "-P", String(pid)], {
			cwd: projectRoot,
		});
	} catch {}
	proc.kill();
	await proc.exited;
}

function startVite() {
	log("Starting Vite HMR server...");
	viteProc = Bun.spawn(VITE_CMD, {
		stdio: ["ignore", "inherit", "inherit"],
		cwd: projectRoot,
	});
	viteProc.exited.then((code) => {
		if (!shuttingDown) warn(`Vite exited with code ${code}`);
	});
}

function startElectrobun() {
	log("Starting electrobun dev...");
	electrobunProc = Bun.spawn(ELECTROBUN_CMD, {
		stdio: ["ignore", "inherit", "inherit"],
		cwd: projectRoot,
	});
	electrobunProc.exited.then((code) => {
		if (!restarting && !shuttingDown) {
			warn(`electrobun dev exited with code ${code}`);
		}
	});
}

async function restartElectrobun() {
	if (restarting) return;
	restarting = true;
	log("Restarting electrobun dev...");

	if (electrobunProc) {
		await killProcessTree(electrobunProc);
		electrobunProc = null;
	}

	await freePort(ELECTROBUN_PORT);

	startElectrobun();
	restarting = false;
}

function scheduleRestart(reason: string) {
	if (debounceTimer) clearTimeout(debounceTimer);
	log(`${reason} — restarting in ${DEBOUNCE_MS / 1000}s...`);
	debounceTimer = setTimeout(() => {
		debounceTimer = null;
		restartElectrobun();
	}, DEBOUNCE_MS);
}

async function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	log("Shutting down...");
	if (debounceTimer) clearTimeout(debounceTimer);

	const kills: Promise<void>[] = [];
	if (electrobunProc) kills.push(killProcessTree(electrobunProc));
	if (viteProc) kills.push(killProcessTree(viteProc));
	await Promise.all(kills);
	process.exit(0);
}

// --- Signal handlers ---
// electrobun's graceful shutdown sends signals to the whole process group.
// Intercept them so the watcher survives child restarts.

let shuttingDown = false;

process.on("SIGINT", () => {
	shutdown();
});
process.on("SIGTERM", () => {
	if (!restarting) shutdown();
});
process.on("SIGHUP", () => {
	if (!restarting) shutdown();
});

// --- File watchers ---

for (const dir of WATCH_DIRS) {
	watch(
		dir,
		{ recursive: true },
		(event: WatchEventType, filename: string | null) => {
			if (!filename) return;
			scheduleRestart(`File changed: ${dir}/${filename}`);
		},
	);
}

log(`Watching ${WATCH_DIRS.join(", ")} for changes...`);


// --- Start ---

// Kill leftover processes from previous runs
killPortOwner(VITE_PORT);
killPortOwner(ELECTROBUN_PORT);

startVite();
startElectrobun();
log("Quit: \x1b[1mCtrl+C\x1b[0m");
