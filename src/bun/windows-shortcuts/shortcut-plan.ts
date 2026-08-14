/**
 * Decides which Windows shortcuts to write, with no filesystem and no Win32 in
 * sight, so the rules are exercised on the machines we develop on. The
 * PowerShell side lives in `powershell-surface.ts`, same split as
 * `windows-icons/`.
 *
 * Why the app does this at all: only electrobun's Setup extractor ever writes a
 * `.lnk`, and the Setup is not published. A user who unpacked the zip therefore
 * has no way to start dev3 after a reboot, and the updater — which installs into
 * the same managed directory the extractor uses — has never created or refreshed
 * a shortcut either. See the decision record `windows-app-owns-its-shortcuts`.
 */

export type ShortcutSlot = "desktop" | "startMenu";

/** One `.lnk` we may write, plus what is at that path right now. */
export interface ShortcutSite {
	slot: ShortcutSlot;
	path: string;
	/** Target of the existing `.lnk`, or `null` when there is no file there. */
	existingTarget: string | null;
}

/** What we wrote last time, persisted between runs. */
export interface ShortcutRecord {
	path: string;
	target: string;
}

export type ShortcutState = Partial<Record<ShortcutSlot, ShortcutRecord>>;

export type ShortcutActionKind = "create" | "repair" | "skip";

export interface ShortcutAction {
	slot: ShortcutSlot;
	path: string;
	kind: ShortcutActionKind;
	/** Logged verbatim — a skipped shortcut must say which rule skipped it. */
	reason: string;
}

export interface ShortcutPlanInput {
	sites: ShortcutSite[];
	/** Absolute path of the `launcher.exe` every shortcut must point at. */
	launcherPath: string;
	state: ShortcutState;
	/** App identifier (`dev3.electrobun.dev`), a segment of the managed install path. */
	identifier: string;
}

const SEPARATOR = String.fromCharCode(92);

function normalizePath(value: string): string {
	return value.trim().split("/").join(SEPARATOR).replace(/\\+$/, "").toLowerCase();
}

function samePath(a: string, b: string): boolean {
	return normalizePath(a) === normalizePath(b);
}

/**
 * A `.lnk` is ours to rewrite only when it points at a `launcher.exe` inside our
 * identifier's install tree, or at exactly the target we recorded writing. Any
 * other shortcut wearing the same file name belongs to somebody else.
 */
function isOurs(target: string, identifier: string, record: ShortcutRecord | undefined): boolean {
	const segments = normalizePath(target).split(SEPARATOR);
	if (segments[segments.length - 1] !== "launcher.exe") return false;
	if (segments.includes(identifier.toLowerCase())) return true;
	return record !== undefined && samePath(target, record.target);
}

/**
 * The rules, in order. Deleting a shortcut we created is a decision the user
 * made: it is recorded and never undone, which is what keeps this from being an
 * app that re-plants an icon on every launch.
 */
export function planShortcuts(input: ShortcutPlanInput): ShortcutAction[] {
	return input.sites.map((site): ShortcutAction => {
		const record = input.state[site.slot];

		if (site.existingTarget === null) {
			if (record && samePath(record.path, site.path)) {
				return { slot: site.slot, path: site.path, kind: "skip", reason: "we created this shortcut and the user removed it" };
			}
			return { slot: site.slot, path: site.path, kind: "create", reason: "no shortcut exists yet" };
		}

		if (samePath(site.existingTarget, input.launcherPath)) {
			return { slot: site.slot, path: site.path, kind: "skip", reason: "shortcut already points at this app" };
		}

		if (isOurs(site.existingTarget, input.identifier, record)) {
			return { slot: site.slot, path: site.path, kind: "repair", reason: `shortcut pointed at ${site.existingTarget}` };
		}

		return { slot: site.slot, path: site.path, kind: "skip", reason: `an unrelated shortcut points at ${site.existingTarget}` };
	});
}

const FORBIDDEN_NAME_CHARS = new Set(["<", ">", ":", '"', "/", SEPARATOR, "|", "?", "*"]);

/**
 * Mirrors electrobun's `windowsShortcutFileName` byte for byte, including its
 * quirk that only the literal channel `production` drops the suffix — our
 * channels are `stable` / `canary` / `dev`, so a stable build is
 * `dev-3.0 (stable).lnk`. Diverging would leave two icons for one app on a box
 * where the Setup extractor also ran.
 */
export function shortcutFileName(appName: string, channel: string): string {
	const display = channel === "production" ? appName : `${appName} (${channelLabel(channel)})`;
	const sanitized = [...display]
		.map((char) => (FORBIDDEN_NAME_CHARS.has(char) || char.charCodeAt(0) < 32 ? "_" : char))
		.join("")
		.replace(/[ .]+$/, "");
	return `${sanitized.length > 0 ? sanitized : "Electrobun App"}.lnk`;
}

function channelLabel(channel: string): string {
	if (channel === "canary") return "Canary";
	if (channel === "dev") return "Development";
	return channel;
}
