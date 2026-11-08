import { describe, expect, it } from "vitest";
import { isClaudePane, savedResumeAccount } from "../ResumeAccountPicker";

const claude = { agentId: "builtin-claude", agentCmd: "claude" };
const codex = { agentId: "builtin-codex", agentCmd: "codex", accountId: "codex-acct" };

describe("savedResumeAccount", () => {
	it("is the first Claude pane's saved account, the system login included", () => {
		expect(savedResumeAccount([codex, { ...claude, accountId: null }], "task-acct")).toBeNull();
		expect(savedResumeAccount([{ ...claude, accountId: "acct-1" }], "task-acct")).toBe("acct-1");
	});

	it("follows the task's account for an old main pane that saved none, as the launch does", () => {
		expect(savedResumeAccount([claude], "task-acct")).toBe("task-acct");
		expect(savedResumeAccount([codex, claude], "task-acct")).toBeUndefined();
	});

	it("has nothing to offer without a Claude pane", () => {
		expect(savedResumeAccount([codex], "task-acct")).toBeUndefined();
	});
});

describe("isClaudePane", () => {
	it("trusts the recorded family over the command name", () => {
		expect(isClaudePane({ agentId: null, agentCmd: "/opt/wrapper", agentFamily: "claude" })).toBe(true);
		expect(isClaudePane({ agentId: null, agentCmd: "claude", agentFamily: "codex" })).toBe(false);
	});
});
