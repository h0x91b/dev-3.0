import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_OUTPUT = 2 * 1024 * 1024;
export function command(file: string, args: string[], timeout = 5_000): Promise<{ ok: boolean; output: string; failure?: string }> {
	return new Promise((resolve) => {
		execFile(file, args, { timeout, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT, encoding: "utf8", cwd: tmpdir(), env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => {
			resolve({ ok: !error, output: stdout.slice(0, MAX_OUTPUT), ...(error ? { failure: String(error.code ?? error.signal ?? "command-failed") } : {}) });
		});
	});
}

export function rendererPids(log: string, hostPid: number): Array<{ pid: number; seenAt: number }> {
	const found = new Map<number, number>();
	for (const line of log.split("\n")) {
		if (!line.includes(`bun[${hostPid}:`) || !line.includes("com.apple.WebKit:")) continue;
		if (!/WebProcessProxy|GPUProcessProxy/.test(line)) continue;
		const pid = Number(line.match(/\bPID=(\d+)/)?.[1]);
		const seenAt = Date.parse(line.slice(0, 23).replace(" ", "T"));
		if (Number.isSafeInteger(pid) && pid > 0 && Number.isFinite(seenAt)) found.set(pid, seenAt);
	}
	return [...found].slice(-8).map(([pid, seenAt]) => ({ pid, seenAt }));
}

export function createCaptureStore(directory: string, session: string) {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	// Only this collector's files are eligible; ordinary app logs and user files stay out.
	const files = readdirSync(directory).filter((name) => /^freeze-\d+-\d+\.((?:previous\.)?jsonl|\d+-(host|renderer-\d+)\.txt)$/.test(name));
	const sessions = [...new Set(files.map((name) => name.split(".")[0]!))].sort().reverse();
	for (const name of files) {
		if (sessions.indexOf(name.split(".")[0]!) >= 4) {
			try { unlinkSync(join(directory, name)); } catch { /* best-effort retention */ }
		}
	}
	let bytes = 0;
	const logPath = join(directory, `${session}.jsonl`);
	function log(value: unknown) {
		const line = `${JSON.stringify(value)}\n`;
		if (Buffer.byteLength(line) > MAX_OUTPUT) return;
		if (bytes + Buffer.byteLength(line) > MAX_OUTPUT) {
			writeFileSync(join(directory, `${session}.previous.jsonl`), readFileSync(logPath), { mode: 0o600 });
			writeFileSync(logPath, "", { mode: 0o600 });
			bytes = 0;
		}
		bytes += Buffer.byteLength(line);
		appendFileSync(logPath, line, { mode: 0o600 });
	}
	function save(name: string, text: string) {
		writeFileSync(join(directory, `${session}.${name}.txt`), text.slice(0, MAX_OUTPUT), { mode: 0o600 });
	}
	return { log, save };
}

export function createStackCapture(hostPid: number, save: (name: string, text: string) => void, run = command) {
	const identities = new Map<number, string>();
	async function identity(pid: number) {
		const result = await run("/bin/ps", ["-p", String(pid), "-o", "lstart=,comm="]);
		return result.ok ? result.output.trim() : "";
	}
	async function discover() {
		const result = await run("/usr/bin/log", ["show", "--last", "5m", "--style", "compact", "--predicate",
			`processIdentifier == ${hostPid} AND subsystem == "com.apple.WebKit"`]);
		if (!result.ok) return;
		for (const { pid, seenAt } of rendererPids(result.output, hostPid)) {
			const value = await identity(pid);
			const bornAt = Date.parse(value.slice(0, 24));
			if (!identities.has(pid) && Number.isFinite(bornAt) && bornAt <= seenAt && /com\.apple\.WebKit\.(WebContent|GPU)/.test(value)) {
				identities.set(pid, value);
				if (identities.size > 16) identities.delete(identities.keys().next().value!);
			}
		}
	}
	async function sample(pid: number, name: string) {
		const result = await run("/usr/bin/sample", [String(pid), "3", "-file", "/dev/stdout"], 8_000);
		save(name, result.output);
		return { pid, ok: result.ok, bytes: Buffer.byteLength(result.output), ...(result.failure ? { failure: result.failure } : {}) };
	}
	async function capture(number: number) {
		// Start the host sample before process discovery: a blocked host may recover meanwhile.
		const host = sample(hostPid, `${number}-host`);
		if (identities.size === 0) {
			try { await discover(); } catch { /* host sample still survives */ }
		}
		const renderers = [...identities].slice(-4).map(async ([pid, expected]) => {
			if (await identity(pid) !== expected) return { pid, skipped: "identity-changed-or-exited" };
			return sample(pid, `${number}-renderer-${pid}`);
		});
		return await Promise.all([host, ...renderers]);
	}
	return { discover, capture };
}
