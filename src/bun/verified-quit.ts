export interface BeforeQuitEvent {
	response?: { allow: boolean };
}

export function createVerifiedQuitGate(options: {
	cleanup: () => Promise<void>;
	retryQuit: () => void;
	onFailure: (error: unknown) => void;
}): (event: BeforeQuitEvent) => void {
	let cleanupComplete = false;
	let cleanupAttempt: Promise<void> | null = null;

	return (event) => {
		if (cleanupComplete) return;
		event.response = { allow: false };
		if (cleanupAttempt) return;

		cleanupAttempt = Promise.resolve()
			.then(options.cleanup)
			.then(() => {
				cleanupComplete = true;
				cleanupAttempt = null;
				options.retryQuit();
			})
			.catch((error: unknown) => {
				cleanupAttempt = null;
				options.onFailure(error);
			});
	};
}
