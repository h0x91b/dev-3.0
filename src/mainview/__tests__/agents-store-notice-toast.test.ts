import { beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_SETTINGS_SECTION_EVENT } from "../state";
import { toast } from "../toast";
import { resetAgentsStoreNoticeToastForTests, showAgentsStoreNoticeToast } from "../agents-store-notice-toast";

const t = ((key: string, vars?: Record<string, string>) => (vars ? `${key} ${JSON.stringify(vars)}` : key)) as never;

describe("showAgentsStoreNoticeToast", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		resetAgentsStoreNoticeToastForTests();
	});

	it("names the backup file and stays until dismissed", () => {
		const warning = vi.spyOn(toast, "warning").mockImplementation(() => 1 as never);
		showAgentsStoreNoticeToast({ kind: "unreadable", backupFile: "agents.json.corrupt-2026-11-25T12-00-00-000Z" }, t);
		const [message, opts] = warning.mock.calls[0];
		expect(message).toContain("toast.agentsStoreUnreadable");
		expect(message).toContain("agents.json.corrupt-2026-11-25T12-00-00-000Z");
		expect(opts!.durationMs).toBe(Number.POSITIVE_INFINITY);
	});

	it("shows a recovery once even when it arrives both pushed and fetched", () => {
		const warning = vi.spyOn(toast, "warning").mockImplementation(() => 1 as never);
		const notice = { kind: "recovered" as const, backupFile: "agents.json.corrupt-x" };
		showAgentsStoreNoticeToast(notice, t);
		showAgentsStoreNoticeToast(notice, t);
		expect(warning).toHaveBeenCalledTimes(1);
		expect(warning.mock.calls[0][0]).toContain("toast.agentsStoreRecovered");
	});

	it("says saves are blocked when no copy could be written, and opens Agent settings", () => {
		const warning = vi.spyOn(toast, "warning").mockImplementation(() => 1 as never);
		const opened = vi.fn();
		window.addEventListener(OPEN_SETTINGS_SECTION_EVENT, opened);
		showAgentsStoreNoticeToast({ kind: "unreadable", backupFile: null }, t);
		const [message, opts] = warning.mock.calls[0];
		expect(message).toBe("toast.agentsStoreUnreadableNoBackup");
		opts!.actions![0].onClick();
		expect((opened.mock.calls[0][0] as CustomEvent).detail).toBe("agents");
		window.removeEventListener(OPEN_SETTINGS_SECTION_EVENT, opened);
	});
});
