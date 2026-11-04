import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../rpc", () => ({ api: { request: { clearAgentBinaryPath: vi.fn() } } }));

import { api } from "../rpc";
import { OPEN_SETTINGS_SECTION_EVENT } from "../state";
import { toast } from "../toast";
import { showStaleAgentPathToast } from "../stale-agent-path-toast";

const t = ((key: string, vars?: Record<string, string>) => (vars ? `${key} ${JSON.stringify(vars)}` : key)) as never;
const detail = { agentId: "builtin-claude", agentName: "Claude Code", path: "/Users/me/.nvm/bin/claude", command: "claude" };

describe("showStaleAgentPathToast", () => {
	beforeEach(() => vi.restoreAllMocks());

	it("warns without printing the home-directory path and resets it in one click", async () => {
		const warning = vi.spyOn(toast, "warning").mockImplementation(() => 1 as never);
		const success = vi.spyOn(toast, "success").mockImplementation(() => 1 as never);
		vi.mocked(api.request.clearAgentBinaryPath).mockResolvedValue(undefined as never);
		showStaleAgentPathToast(detail, t);
		const [message, opts] = warning.mock.calls[0];
		expect(message).not.toContain(detail.path);
		const reset = opts!.actions!.find((a) => a.label === "toast.staleAgentPathReset")!;
		reset.onClick();
		await vi.waitFor(() => expect(api.request.clearAgentBinaryPath).toHaveBeenCalledWith({ agentId: "builtin-claude" }));
		await vi.waitFor(() => expect(success).toHaveBeenCalled());
	});

	it("reports a failed reset as an error, and Settings opens the Agents section", async () => {
		const warning = vi.spyOn(toast, "warning").mockImplementation(() => 1 as never);
		const error = vi.spyOn(toast, "error").mockImplementation(() => 1 as never);
		vi.mocked(api.request.clearAgentBinaryPath).mockRejectedValue(new Error("nope"));
		const opened = vi.fn();
		window.addEventListener(OPEN_SETTINGS_SECTION_EVENT, opened);
		showStaleAgentPathToast(detail, t);
		const actions = warning.mock.calls[0][1]!.actions!;
		actions.find((a) => a.label === "toast.staleAgentPathReset")!.onClick();
		await vi.waitFor(() => expect(error).toHaveBeenCalledWith("settings.agentPathResetFailed", expect.anything()));
		actions.find((a) => a.label === "toast.staleAgentPathSettings")!.onClick();
		expect((opened.mock.calls[0][0] as CustomEvent).detail).toBe("agents");
		window.removeEventListener(OPEN_SETTINGS_SECTION_EVENT, opened);
	});
});
