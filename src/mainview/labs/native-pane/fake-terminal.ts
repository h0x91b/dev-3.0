export const FAKE_TERMINAL_BUFFER_LIMIT = 240;

export interface FakeOutputEvent {
	paneId: string;
	line: string;
	sequence: number;
}

export interface FakeInputEvent {
	paneId: string;
	data: string;
}

export interface FakeResizeEvent {
	paneId: string;
	columns: number;
	rows: number;
}

export interface FakeTerminalDiagnostics {
	activeSessions: number;
	runningTimers: number;
	outputSubscriptions: number;
	inputSubscriptions: number;
	resizeSubscriptions: number;
	disposedSessions: number;
	outputEvents: number;
	inputEvents: number;
	resizeEvents: number;
}

interface RegistryCounters {
	disposedSessions: number;
	outputEvents: number;
	inputEvents: number;
	resizeEvents: number;
}

type OutputListener = (event: FakeOutputEvent) => void;
type InputListener = (event: FakeInputEvent) => void;
type ResizeListener = (event: FakeResizeEvent) => void;

export class FakeTerminalSession {
	readonly streamId: string;
	private readonly outputListeners = new Set<OutputListener>();
	private readonly inputListeners = new Set<InputListener>();
	private readonly resizeListeners = new Set<ResizeListener>();
	private readonly outputLines: string[];
	private outputSequence = 0;
	private columns = 80;
	private rows = 24;
	private timer: ReturnType<typeof setInterval> | null = null;
	private disposed = false;

	constructor(
		readonly paneId: string,
		private readonly outputIntervalMs: number,
		private readonly counters: RegistryCounters,
	) {
		this.streamId = `fake-terminal:${paneId}`;
		this.outputLines = [`[${paneId}] #0000 · 00/04`];
	}

	get running(): boolean {
		return this.timer !== null;
	}

	get subscriptionCounts(): { output: number; input: number; resize: number } {
		return {
			output: this.outputListeners.size,
			input: this.inputListeners.size,
			resize: this.resizeListeners.size,
		};
	}

	getOutputLines(): readonly string[] {
		return this.outputLines;
	}

	getSize(): FakeResizeEvent {
		return { paneId: this.paneId, columns: this.columns, rows: this.rows };
	}

	start(): void {
		if (this.disposed || this.timer !== null) return;
		this.timer = setInterval(() => this.emitScriptedOutput(), this.outputIntervalMs);
	}

	stop(): void {
		if (this.timer === null) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	subscribeOutput(listener: OutputListener): () => void {
		if (this.disposed) return () => {};
		this.outputListeners.add(listener);
		for (const line of this.outputLines) {
			listener({ paneId: this.paneId, line, sequence: this.outputSequence });
		}
		return () => this.outputListeners.delete(listener);
	}

	subscribeInput(listener: InputListener): () => void {
		if (this.disposed) return () => {};
		this.inputListeners.add(listener);
		return () => this.inputListeners.delete(listener);
	}

	subscribeResize(listener: ResizeListener): () => void {
		if (this.disposed) return () => {};
		this.resizeListeners.add(listener);
		return () => this.resizeListeners.delete(listener);
	}

	emitScriptedOutput(): void {
		if (this.disposed) return;
		this.outputSequence += 1;
		const phase = String(this.outputSequence % 4).padStart(2, "0");
		this.emitOutput(`[${this.paneId}] #${String(this.outputSequence).padStart(4, "0")} · ${phase}/04`);
	}

	writeInput(data: string): void {
		if (this.disposed) return;
		const event = { paneId: this.paneId, data };
		this.counters.inputEvents += 1;
		for (const listener of this.inputListeners) listener(event);
		this.emitOutput(`$ ${data}`);
	}

	resize(columns: number, rows: number): void {
		if (this.disposed) return;
		const nextColumns = Math.max(1, Math.floor(columns));
		const nextRows = Math.max(1, Math.floor(rows));
		if (nextColumns === this.columns && nextRows === this.rows) return;
		this.columns = nextColumns;
		this.rows = nextRows;
		const event = { paneId: this.paneId, columns: nextColumns, rows: nextRows };
		this.counters.resizeEvents += 1;
		for (const listener of this.resizeListeners) listener(event);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stop();
		this.outputListeners.clear();
		this.inputListeners.clear();
		this.resizeListeners.clear();
		this.counters.disposedSessions += 1;
	}

	private emitOutput(line: string): void {
		this.outputLines.push(line);
		if (this.outputLines.length > FAKE_TERMINAL_BUFFER_LIMIT) {
			this.outputLines.splice(0, this.outputLines.length - FAKE_TERMINAL_BUFFER_LIMIT);
		}
		this.counters.outputEvents += 1;
		const event = { paneId: this.paneId, line, sequence: this.outputSequence };
		for (const listener of this.outputListeners) listener(event);
	}
}

export interface FakeTerminalRegistryOptions {
	outputIntervalMs?: number;
}

export class FakeTerminalRegistry {
	private readonly sessions = new Map<string, FakeTerminalSession>();
	private readonly outputIntervalMs: number;
	private readonly counters: RegistryCounters = {
		disposedSessions: 0,
		outputEvents: 0,
		inputEvents: 0,
		resizeEvents: 0,
	};

	constructor(options: FakeTerminalRegistryOptions = {}) {
		this.outputIntervalMs = Math.max(1, options.outputIntervalMs ?? 500);
	}

	ensure(paneId: string): FakeTerminalSession {
		let session = this.sessions.get(paneId);
		if (!session) {
			session = new FakeTerminalSession(paneId, this.outputIntervalMs, this.counters);
			this.sessions.set(paneId, session);
		}
		session.start();
		return session;
	}

	get(paneId: string): FakeTerminalSession | undefined {
		return this.sessions.get(paneId);
	}

	reconcile(paneIds: readonly string[]): void {
		const wanted = new Set(paneIds);
		for (const [paneId, session] of this.sessions) {
			if (wanted.has(paneId)) continue;
			session.dispose();
			this.sessions.delete(paneId);
		}
		for (const paneId of paneIds) this.ensure(paneId);
	}

	diagnostics(): FakeTerminalDiagnostics {
		let runningTimers = 0;
		let outputSubscriptions = 0;
		let inputSubscriptions = 0;
		let resizeSubscriptions = 0;
		for (const session of this.sessions.values()) {
			if (session.running) runningTimers += 1;
			const subscriptions = session.subscriptionCounts;
			outputSubscriptions += subscriptions.output;
			inputSubscriptions += subscriptions.input;
			resizeSubscriptions += subscriptions.resize;
		}
		return {
			activeSessions: this.sessions.size,
			runningTimers,
			outputSubscriptions,
			inputSubscriptions,
			resizeSubscriptions,
			...this.counters,
		};
	}

	dispose(): void {
		for (const session of this.sessions.values()) session.dispose();
		this.sessions.clear();
	}
}
