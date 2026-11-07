import { describe, it, expect } from "vitest";
import en from "../../i18n/translations/en";
import ru from "../../i18n/translations/ru";
import { interpolate } from "../../i18n/interpolate";
import type { TFunction } from "../../i18n";
import { preparationFailureMessage } from "../preparationFailureMessage";
import { classifyPreparationFailure, startBranchMissingMessage } from "../../../shared/preparation-failure";

function tFor(table: Readonly<Record<string, string>>): TFunction {
	const t = ((key: string, vars?: Record<string, string | number>) => interpolate(table[key], vars ?? {})) as TFunction;
	t.plural = () => "";
	return t;
}

describe("preparationFailureMessage", () => {
	const thrown = startBranchMissingMessage("feat/dev3-global-env-defaults");

	it("recognises the message createWorktree throws for a deleted start branch", () => {
		expect(classifyPreparationFailure(thrown)).toEqual({
			kind: "start-branch-missing",
			branch: "feat/dev3-global-env-defaults",
			rest: "",
		});
	});

	it("renders it in the user's language, naming the branch", () => {
		const message = preparationFailureMessage(thrown, tFor(ru));
		expect(message).toBe(interpolate(ru["task.startBranchMissing"], { branch: "feat/dev3-global-env-defaults" }));
		expect(message).toContain("feat/dev3-global-env-defaults");
		expect(message).not.toContain("invalid reference");
	});

	it("keeps lines the lifecycle appended after the error", () => {
		const message = preparationFailureMessage(`${thrown}\nKept the folder /tmp/x`, tFor(en));
		expect(message.split("\n")).toEqual([
			interpolate(en["task.startBranchMissing"], { branch: "feat/dev3-global-env-defaults" }),
			"Kept the folder /tmp/x",
		]);
	});

	it("passes any other error through unchanged", () => {
		const raw = "Failed to create worktree: fatal: could not lock config file";
		expect(preparationFailureMessage(raw, tFor(en))).toBe(raw);
	});
});
