// Build-time switch shared by every telemetry channel. Read per call so Vite
// constant-folds it in a build while `vi.stubEnv` can still flip it in tests.
export function telemetryEnabled(): boolean {
	return import.meta.env.VITE_TELEMETRY !== "off";
}
