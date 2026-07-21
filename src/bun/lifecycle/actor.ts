type MailboxItem<Event, Result> = {
	event: Event;
	resolve: (result: Result) => void;
	reject: (error: unknown) => void;
};

class TaskActor<Event, Result, Runtime> {
	private readonly mailbox: Array<MailboxItem<Event, Result>> = [];
	private draining = false;

	constructor(
		readonly taskId: string,
		private readonly process: (taskId: string, event: Event) => Promise<Result>,
		readonly runtime: Runtime,
	) {}

	dispatch(event: Event): Promise<Result> {
		return new Promise<Result>((resolve, reject) => {
			this.mailbox.push({ event, resolve, reject });
			void this.drain();
		});
	}

	private async drain(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			while (this.mailbox.length > 0) {
				const item = this.mailbox[0];
				try {
					item.resolve(await this.process(this.taskId, item.event));
				} catch (error) {
					item.reject(error);
				} finally {
					this.mailbox.shift();
				}
			}
		} finally {
			this.draining = false;
			// An enqueue can land after the loop sees an empty mailbox but before
			// `draining` is cleared. Give that event the drain it could not start.
			if (this.mailbox.length > 0) void this.drain();
		}
	}
}

export class TaskActorRegistry<Event, Result, Runtime = Record<string, unknown>> {
	private readonly actors = new Map<string, TaskActor<Event, Result, Runtime>>();

	constructor(
		private readonly process: (taskId: string, event: Event) => Promise<Result>,
		private readonly createRuntime: () => Runtime = (() => ({} as Runtime)),
	) {}

	private actor(taskId: string): TaskActor<Event, Result, Runtime> {
		let actor = this.actors.get(taskId);
		if (!actor) {
			actor = new TaskActor(taskId, this.process, this.createRuntime());
			this.actors.set(taskId, actor);
		}
		return actor;
	}

	dispatch(taskId: string, event: Event): Promise<Result> {
		return this.actor(taskId).dispatch(event);
	}

	runtime(taskId: string): Runtime {
		return this.actor(taskId).runtime;
	}

	forEachRuntime(visitor: (runtime: Runtime, taskId: string) => void): void {
		for (const [taskId, actor] of this.actors) visitor(actor.runtime, taskId);
	}

	delete(taskId: string): void {
		this.actors.delete(taskId);
	}

	clear(): void {
		this.actors.clear();
	}
}
