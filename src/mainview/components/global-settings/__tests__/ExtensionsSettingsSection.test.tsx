import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ExtensionInspection, ExtensionsOverview, InstalledExtension } from "../../../../shared/extensions";
import { api } from "../../../rpc";
import { openFolderPicker } from "../../../folder-picker";
import { isRemote } from "../../../utils/platform";
import { resetBoardPluginsForTests } from "../../../board-views/plugins";
import { resetBoardRootForTests } from "../../../board-views/root";
import ExtensionsSettingsSection from "../ExtensionsSettingsSection";

vi.mock("../../../rpc", () => ({
	api: {
		request: {
			listExtensions: vi.fn(),
			inspectExtension: vi.fn(),
			installExtension: vi.fn(),
			setExtensionsEnabled: vi.fn(),
			setExtensionEnabled: vi.fn(),
			setBuiltinBoardViewEnabled: vi.fn(),
			getExtensionSource: vi.fn().mockRejectedValue(new Error("not in tests")),
		},
	},
}));
vi.mock("../../../folder-picker", () => ({ openFolderPicker: vi.fn() }));
vi.mock("../../../utils/platform", () => ({ isRemote: vi.fn(() => false) }));
vi.mock("../../../i18n", () => ({ useT: () => ((key: string) => key) }));

const t = ((key: string) => key) as never;

const focusList: InstalledExtension = {
	id: "focus-list",
	status: "untrusted",
	manifest: {
		id: "focus-list", name: "Focus list", version: "1.0.0", publisher: "Someone", engines: { dev3: "^1.0.0" }, main: "index.js",
		contributes: { boardViews: [{ id: "focus", label: "Focus list" }] },
	},
};

function overview(patch: Partial<ExtensionsOverview> = {}): ExtensionsOverview {
	return { enabled: true, enabledSetting: true, lockedBy: null, apiVersion: "1.0.0", disabledBuiltins: [], extensions: [], ...patch };
}

beforeEach(() => {
	resetBoardRootForTests();
	resetBoardPluginsForTests();
	vi.mocked(isRemote).mockReturnValue(false);
	vi.mocked(api.request.listExtensions).mockResolvedValue(overview());
	for (const fn of [api.request.installExtension, api.request.setExtensionsEnabled, api.request.inspectExtension]) vi.mocked(fn).mockReset();
});

describe("ExtensionsSettingsSection", () => {
	it("puts the kill switch first, lists Kanban as always on, and offers Install from folder", async () => {
		render(<ExtensionsSettingsSection t={t} />);
		const switches = await screen.findAllByRole("switch");
		expect(switches[0]).toHaveAccessibleName("extensions.killSwitch");
		const builtins = screen.getByTestId("builtin-board-views");
		expect(within(builtins).getByText("extensions.alwaysOn")).toBeInTheDocument();
		expect(within(builtins).getAllByRole("switch")).toHaveLength(1); // Table; Kanban has none
		expect(screen.getByTestId("extensions-install")).toBeInTheDocument();
	});

	it("asks for consent with Cancel focused, and installs only after Trust and install", async () => {
		const inspection: ExtensionInspection = {
			manifest: focusList.manifest!, sourcePath: "/Users/me/ext/focus-list", compatible: true, alreadyTrusted: false,
		};
		vi.mocked(openFolderPicker).mockResolvedValue("/Users/me/ext/focus-list");
		vi.mocked(api.request.inspectExtension).mockResolvedValue(inspection);
		vi.mocked(api.request.installExtension).mockResolvedValue({ ...focusList, status: "active" });
		render(<ExtensionsSettingsSection t={t} />);
		fireEvent.click(await screen.findByTestId("extensions-install"));
		const dialog = await screen.findByTestId("extension-consent");
		expect(within(dialog).getByTestId("extension-consent-cancel")).toHaveFocus();
		expect(within(dialog).getByText("/Users/me/ext/focus-list")).toHaveClass("streamer-private");
		expect(api.request.installExtension).not.toHaveBeenCalled();

		fireEvent.keyDown(dialog, { key: "Escape" });
		expect(screen.queryByTestId("extension-consent")).not.toBeInTheDocument();
		expect(api.request.installExtension).not.toHaveBeenCalled();

		fireEvent.click(screen.getByTestId("extensions-install"));
		fireEvent.click(await screen.findByTestId("extension-consent-confirm"));
		await waitFor(() => expect(api.request.installExtension).toHaveBeenCalledWith({ path: "/Users/me/ext/focus-list", consent: true }));
	});

	it("skips consent for an update from a publisher already trusted", async () => {
		vi.mocked(openFolderPicker).mockResolvedValue("/x");
		vi.mocked(api.request.inspectExtension).mockResolvedValue({
			manifest: focusList.manifest!, sourcePath: "/x", compatible: true, alreadyTrusted: true,
		});
		vi.mocked(api.request.installExtension).mockResolvedValue({ ...focusList, status: "active" });
		render(<ExtensionsSettingsSection t={t} />);
		fireEvent.click(await screen.findByTestId("extensions-install"));
		await waitFor(() => expect(api.request.installExtension).toHaveBeenCalledWith({ path: "/x", consent: false }));
		expect(screen.queryByTestId("extension-consent")).not.toBeInTheDocument();
	});

	it("shows an untrusted, hand-copied extension with a status chip and a way to review it", async () => {
		vi.mocked(api.request.listExtensions).mockResolvedValue(overview({ extensions: [focusList] }));
		render(<ExtensionsSettingsSection t={t} />);
		const row = await screen.findByTestId("extension-row-focus-list");
		expect(within(row).getByTestId("extension-status")).toHaveTextContent("extensions.status.untrusted");
		fireEvent.click(within(row).getByText("extensions.trust"));
		expect(await screen.findByText("extensions.consent.confirmTrust")).toBeInTheDocument();
	});

	it("in a remote session, hides install and lets the kill switch go only towards off", async () => {
		vi.mocked(isRemote).mockReturnValue(true);
		vi.mocked(api.request.listExtensions).mockResolvedValue(overview({ extensions: [{ ...focusList, status: "active" }] }));
		const { unmount } = render(<ExtensionsSettingsSection t={t} />);
		await screen.findByTestId("extension-row-focus-list");
		expect(screen.queryByTestId("extensions-install")).not.toBeInTheDocument();
		expect(screen.getByText("extensions.remoteReadOnly")).toBeInTheDocument();
		const [killSwitch, ...rest] = screen.getAllByRole("switch");
		expect(killSwitch).toHaveAttribute("tabindex", "0");
		for (const other of rest) expect(other).toHaveAttribute("tabindex", "-1");
		fireEvent.click(killSwitch);
		await waitFor(() => expect(api.request.setExtensionsEnabled).toHaveBeenCalledWith({ enabled: false }));
		unmount();

		vi.mocked(api.request.listExtensions).mockResolvedValue(overview({ enabled: false, enabledSetting: false }));
		render(<ExtensionsSettingsSection t={t} />);
		await screen.findByText("extensions.killSwitchRemoteOnlyOff");
		expect(screen.getAllByRole("switch")[0]).toHaveAttribute("tabindex", "-1");
	});

	it("says when DEV3_EXTENSIONS=off locks the switch", async () => {
		vi.mocked(api.request.listExtensions).mockResolvedValue(overview({ enabled: false, lockedBy: "env" }));
		render(<ExtensionsSettingsSection t={t} />);
		expect(await screen.findByText("extensions.killSwitchLockedEnv")).toBeInTheDocument();
		expect(screen.getAllByRole("switch")[0]).toHaveAttribute("tabindex", "-1");
	});
});
