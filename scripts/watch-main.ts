import { watch, type WatchEventType } from "node:fs";

const WATCH_DIRS = ["src/bun", "src/shared"];
const DEBOUNCE_MS = 2000;
const ELECTROBUN_CMD = ["bunx", "electrobun", "dev"];
const ELECTROBUN_PORT = 7681;
const PORT_WAIT_TIMEOUT = 10_000;
const PORT_POLL_INTERVAL = 200;

let electrobunProc: ReturnType<typeof Bun.spawn> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let restarting = false;
const projectRoot = import.meta.dir + "/..";

const log = (msg: string) =>
	console.log(`\x1b[36m[watch]\x1b[0m ${msg}`);

async function waitForPortFree(port: number): Promise<boolean> {
	const deadline = Date.now() + PORT_WAIT_TIMEOUT;
	while (Date.now() < deadline) {
		try {
			const server = Bun.listen({
				hostname: "127.0.0.1",
				port,
				socket: { data() {} },
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
	try {
		const result = Bun.spawnSync(["lsof", "-ti", `tcp:${port}`], {
			cwd: projectRoot,
		});
		const pids = result.stdout.toString().trim();
		if (pids) {
			for (const pid of pids.split("\n")) {
				log(`Killing leftover process ${pid} on port ${port}`);
				try { process.kill(Number(pid), "SIGKILL"); } catch {}
			}
		}
	} catch {}
}

function startElectrobun() {
	log("Starting electrobun dev...");
	electrobunProc = Bun.spawn(ELECTROBUN_CMD, {
		stdio: ["ignore", "inherit", "inherit"],
		cwd: projectRoot,
	});

	// When electrobun exits on its own (window closed, crash) — exit watcher,
	// concurrently's --kill-others will take care of vite
	electrobunProc.exited.then((code) => {
		if (restarting) return;
		log(`electrobun dev exited (code ${code}), shutting down...`);
		process.exit(0);
	});
}

async function restartElectrobun() {
	if (restarting) return;
	restarting = true;
	log("Restarting electrobun dev...");

	if (electrobunProc) {
		const pid = electrobunProc.pid;
		try { Bun.spawnSync(["pkill", "-TERM", "-P", String(pid)], { cwd: projectRoot }); } catch {}
		electrobunProc.kill();
		await electrobunProc.exited;
		electrobunProc = null;
	}

	killPortOwner(ELECTROBUN_PORT);
	await waitForPortFree(ELECTROBUN_PORT);

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

// --- Stdin: catch Ctrl+C (0x03) piped from concurrently --handle-input ---
// Electrobun puts the terminal in raw mode for its PTY server, which
// disables SIGINT generation. concurrently reads the raw byte and pipes
// it to us, so we catch it here and exit.
process.stdin.resume();
process.stdin.on("data", (data: Buffer) => {
	if (data[0] === 0x03) {
		log("Ctrl+C received, shutting down...");
		if (electrobunProc) try { electrobunProc.kill(); } catch {}
		process.exit(0);
	}
});

// --- File watchers ---

for (const dir of WATCH_DIRS) {
	watch(dir, { recursive: true }, (_event: WatchEventType, filename: string | null) => {
		if (!filename) return;
		scheduleRestart(`File changed: ${dir}/${filename}`);
	});
}

log(`Watching ${WATCH_DIRS.join(", ")} for changes...`);

// --- Start ---

killPortOwner(ELECTROBUN_PORT);
startElectrobun();
