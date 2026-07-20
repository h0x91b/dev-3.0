/** Windows Job Object ownership for the isolated detached-PTY prototype. */

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_QUERY = 0x0004;
const JOB_OBJECT_TERMINATE = 0x0008;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const ERROR_ALREADY_EXISTS = 183;
const NULL_HANDLE = 0n;

export type WindowsHandle = bigint;

export interface WindowsJobApi {
	createJob(name: string): WindowsHandle;
	setExtendedLimitInformation(job: WindowsHandle, limits: BigUint64Array): boolean;
	openProcess(pid: number, access?: number): WindowsHandle;
	assignProcess(job: WindowsHandle, process: WindowsHandle): boolean;
	openJob(name: string, access?: number): WindowsHandle;
	terminateJob(job: WindowsHandle): boolean;
	isProcessInJob(process: WindowsHandle, job: WindowsHandle): boolean;
	closeHandle(handle: WindowsHandle): boolean;
	setLastError(code: number): void;
	lastError(): number;
	dispose(): void;
}

export function windowsJobName(sessionToken: string): string {
	if (!/^[0-9a-f]{48}$/i.test(sessionToken)) {
		throw new Error("invalid detached-pty session token for Windows Job Object");
	}
	return `Local\\dev3-pty-proto-${sessionToken.toLowerCase()}`;
}

function extendedLimits(): BigUint64Array {
	// JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on Windows x64/arm64.
	const limits = new BigUint64Array(18);
	new DataView(limits.buffer).setUint32(16, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
	return limits;
}

function win32Error(api: WindowsJobApi, operation: string): Error {
	return new Error(`${operation} failed (Win32 error ${api.lastError()})`);
}

export class WindowsJobContainment {
	private handle: WindowsHandle | null;

	constructor(
		readonly name: string,
		handle: WindowsHandle,
		private readonly api: WindowsJobApi,
	) {
		this.handle = handle;
	}

	/** Close the last owned handle. Kill-on-close terminates this host and its tree. */
	closeForTreeTermination(): boolean {
		if (this.handle === null) return false;
		const handle = this.handle;
		this.handle = null;
		try {
			return this.api.closeHandle(handle);
		} finally {
			this.api.dispose();
		}
	}
}

/** Create, configure, and self-enrol the detached host before it spawns a shell. */
export function createWindowsJobWithApi(sessionToken: string, hostPid: number, api: WindowsJobApi): WindowsJobContainment {
	const name = windowsJobName(sessionToken);
	api.setLastError(0);
	const job = api.createJob(name);
	if (job === NULL_HANDLE) {
		const error = win32Error(api, "CreateJobObjectW");
		api.dispose();
		throw error;
	}
	if (api.lastError() === ERROR_ALREADY_EXISTS) {
		api.closeHandle(job);
		api.dispose();
		throw new Error(`refusing to reuse existing Windows Job Object ${name}`);
	}

	try {
		if (!api.setExtendedLimitInformation(job, extendedLimits())) {
			throw win32Error(api, "SetInformationJobObject");
		}
		const host = api.openProcess(hostPid);
		if (host === NULL_HANDLE) throw win32Error(api, "OpenProcess");
		try {
			if (!api.assignProcess(job, host)) {
				throw win32Error(api, "AssignProcessToJobObject");
			}
		} finally {
			api.closeHandle(host);
		}
		return new WindowsJobContainment(name, job, api);
	} catch (error) {
		api.closeHandle(job);
		api.dispose();
		throw error;
	}
}

async function loadWindowsJobApi(): Promise<WindowsJobApi> {
	const { dlopen, FFIType } = await import("bun:ffi");
	const { i32, ptr, u32, u64 } = FFIType;
	const library = dlopen("kernel32.dll", {
		CreateJobObjectW: { args: [ptr, ptr], returns: u64 },
		SetInformationJobObject: { args: [u64, u32, ptr, u32], returns: i32 },
		OpenProcess: { args: [u32, i32, u32], returns: u64 },
		AssignProcessToJobObject: { args: [u64, u64], returns: i32 },
		OpenJobObjectW: { args: [u32, i32, ptr], returns: u64 },
		TerminateJobObject: { args: [u64, u32], returns: i32 },
		IsProcessInJob: { args: [u64, u64, ptr], returns: i32 },
		CloseHandle: { args: [u64], returns: i32 },
		SetLastError: { args: [u32], returns: FFIType.void },
		GetLastError: { args: [], returns: u32 },
	} as const);
	const symbols = library.symbols;
	const wide = (value: string): Uint16Array => {
		const out = new Uint16Array(value.length + 1);
		for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i);
		return out;
	};

	return {
		createJob: (name) => symbols.CreateJobObjectW(null, wide(name)),
		setExtendedLimitInformation: (job, limits) =>
			symbols.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, limits, limits.byteLength) !== 0,
		openProcess: (pid, access = PROCESS_TERMINATE | PROCESS_SET_QUOTA) => symbols.OpenProcess(access, 0, pid),
		assignProcess: (job, processHandle) => symbols.AssignProcessToJobObject(job, processHandle) !== 0,
		openJob: (name, access = JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE) => symbols.OpenJobObjectW(access, 0, wide(name)),
		terminateJob: (job) => symbols.TerminateJobObject(job, 1) !== 0,
		isProcessInJob: (processHandle, job) => {
			const result = new Int32Array(1);
			if (symbols.IsProcessInJob(processHandle, job, result) === 0) return false;
			return result[0] !== 0;
		},
		closeHandle: (handle) => symbols.CloseHandle(handle) !== 0,
		setLastError: (code) => symbols.SetLastError(code),
		lastError: () => symbols.GetLastError(),
		dispose: () => library.close(),
	};
}

/** No-op on POSIX; Windows failures abort only the isolated native host startup. */
export async function createWindowsJobContainment(sessionToken: string): Promise<WindowsJobContainment | null> {
	if (process.platform !== "win32") return null;
	return createWindowsJobWithApi(sessionToken, process.pid, await loadWindowsJobApi());
}

export function forceTerminateWindowsJobWithApi(sessionToken: string, api: WindowsJobApi): boolean {
	const job = api.openJob(windowsJobName(sessionToken), JOB_OBJECT_TERMINATE);
	if (job === NULL_HANDLE) {
		api.dispose();
		return false;
	}
	try {
		return api.terminateJob(job);
	} finally {
		api.closeHandle(job);
		api.dispose();
	}
}

export async function forceTerminateWindowsJob(sessionToken: string): Promise<boolean> {
	if (process.platform !== "win32") return false;
	return forceTerminateWindowsJobWithApi(sessionToken, await loadWindowsJobApi());
}

export function windowsJobExistsWithApi(sessionToken: string, api: WindowsJobApi): boolean {
	const job = api.openJob(windowsJobName(sessionToken), JOB_OBJECT_QUERY);
	if (job === NULL_HANDLE) {
		api.dispose();
		return false;
	}
	api.closeHandle(job);
	api.dispose();
	return true;
}

export async function windowsJobExists(sessionToken: string): Promise<boolean> {
	if (process.platform !== "win32") return false;
	return windowsJobExistsWithApi(sessionToken, await loadWindowsJobApi());
}

export function isProcessInWindowsJobWithApi(sessionToken: string, pid: number, api: WindowsJobApi): boolean {
	const job = api.openJob(windowsJobName(sessionToken), JOB_OBJECT_QUERY);
	const processHandle = api.openProcess(pid, PROCESS_QUERY_LIMITED_INFORMATION);
	if (job === NULL_HANDLE || processHandle === NULL_HANDLE) {
		if (job !== NULL_HANDLE) api.closeHandle(job);
		if (processHandle !== NULL_HANDLE) api.closeHandle(processHandle);
		api.dispose();
		return false;
	}
	try {
		return api.isProcessInJob(processHandle, job);
	} finally {
		api.closeHandle(processHandle);
		api.closeHandle(job);
		api.dispose();
	}
}

export async function isProcessInWindowsJob(sessionToken: string, pid: number): Promise<boolean> {
	if (process.platform !== "win32") return false;
	return isProcessInWindowsJobWithApi(sessionToken, pid, await loadWindowsJobApi());
}
