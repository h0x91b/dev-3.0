/**
 * Which running dev3 instance a CLI command should talk to.
 *
 * Several instances share one `~/.dev3.0/`: the installed app plus a dev build
 * booted by a task's devScript or a headless `dev3 remote` (a "guest", tagged by
 * `hostTaskId` in its socket sidecar). Discovery deliberately prefers the primary
 * (issues #910/#920), so a human who wants the guest needs to say so.
 *
 * The selector is only ever supplied EXPLICITLY — the `--instance` flag or the
 * `DEV3_CLI_SOCKET` env override. Agent hooks and lifecycle onExit commands pass
 * neither, so their routing is untouched by construction. In particular
 * `DEV3_TASK_ID` (injected into every task pane, hooks included) is NOT a
 * selector: treating it as one would route every task's hooks into its guest.
 */

export type InstanceSelector =
	/** The installed/primary app — the instance discovery already prefers. */
	| { kind: "primary" }
	/** The instance hosted by the task this shell belongs to. */
	| { kind: "self" }
	/** The instance hosted by a task, addressed by id or id prefix. */
	| { kind: "task"; ref: string }
	/** The instance hosted by a task, addressed by its human number. */
	| { kind: "seq"; seq: number };

export const INSTANCE_FLAG = "--instance";

/** Accepted spellings, for help text and error messages. */
export const INSTANCE_SELECTOR_SYNTAX = "self | primary | task:<id> | seq:<N>";

/** Parse an `--instance` value. Returns null when the spelling is not one of ours. */
export function parseInstanceSelector(raw: string): InstanceSelector | null {
	const value = raw.trim();
	if (value === "self") return { kind: "self" };
	if (value === "primary") return { kind: "primary" };

	const task = /^task:(.+)$/.exec(value);
	if (task) {
		const ref = task[1].trim();
		return ref ? { kind: "task", ref } : null;
	}

	const seq = /^seq:(\d+)$/.exec(value);
	if (seq) return { kind: "seq", seq: parseInt(seq[1], 10) };

	return null;
}

/** Render a selector back into its `--instance` value (used by the armed shim). */
export function formatInstanceSelector(selector: InstanceSelector): string {
	switch (selector.kind) {
		case "primary":
			return "primary";
		case "self":
			return "self";
		case "task":
			return `task:${selector.ref}`;
		case "seq":
			return `seq:${selector.seq}`;
	}
}
