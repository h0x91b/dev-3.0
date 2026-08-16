// Build-time switch shared by every telemetry channel. Read per call so Vite
// constant-folds it in a build while `vi.stubEnv` can still flip it in tests.
// Spelling is forgiving on purpose: a packager who writes `false` or `0` means
// off, and silently shipping telemetry to them is the expensive failure here.
const OFF_VALUES = ["off", "false", "0", "no"];

export function telemetryEnabled(): boolean {
	const value = String(import.meta.env.VITE_TELEMETRY ?? "").trim().toLowerCase();
	return !OFF_VALUES.includes(value);
}
