import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalSettings, PxpipeProxyStatus } from "../../../../shared/types";
import { I18nProvider, type TFunction } from "../../../i18n";
import PxpipeProxySettingsSection from "../PxpipeProxySettingsSection";

vi.mock("../../../rpc", () => ({
	api: {
		request: {
			pxpipeProxyStatus: vi.fn(),
			pxpipeProxyStart: vi.fn(),
			pxpipeProxyStop: vi.fn(),
		},
	},
}));

import { api } from "../../../rpc";

// Stub translator: return the key so assertions are stable and locale-agnostic.
const t = ((key: string) => key) as unknown as TFunction;

function makeStatus(over: Partial<PxpipeProxyStatus> = {}): PxpipeProxyStatus {
	return {
		enabled: true,
		npxAvailable: true,
		npxPath: "/usr/bin/npx",
		port: 47821,
		portInUse: false,
		running: false,
		starting: false,
		foreignConflict: false,
		dashboardUrl: "http://127.0.0.1:47821/",
		...over,
	};
}

function renderSection(enabled: boolean) {
	const onToggle = vi.fn();
	render(
		<I18nProvider>
			<PxpipeProxySettingsSection
				t={t}
				globalSettings={{ pxpipeProxyEnabled: enabled } as GlobalSettings}
				onToggle={onToggle}
			/>
		</I18nProvider>,
	);
	return { onToggle };
}

beforeEach(() => {
	vi.clearAllMocks();
	(api.request.pxpipeProxyStatus as ReturnType<typeof vi.fn>).mockResolvedValue(makeStatus());
	(api.request.pxpipeProxyStop as ReturnType<typeof vi.fn>).mockResolvedValue(makeStatus());
});

describe("PxpipeProxySettingsSection", () => {
	it("always shows the honesty warning and toggle; hides the status block while off", () => {
		const { onToggle } = renderSection(false);
		expect(screen.getByText("pxpipe.warningTitle")).toBeInTheDocument();
		expect(screen.getByText("pxpipe.enableLabel")).toBeInTheDocument();
		expect(screen.queryByText("pxpipe.start")).not.toBeInTheDocument();
		expect(onToggle).not.toHaveBeenCalled();
	});

	it("always exposes the pxpipe repo link but hides the dashboard link while off", () => {
		renderSection(false);
		expect(screen.getByText("pxpipe.viewRepo").closest("a")).toHaveAttribute(
			"href",
			"https://github.com/teamchong/pxpipe",
		);
		// The dashboard only works once the proxy is running, so it must not appear
		// while the feature is off.
		expect(screen.queryByText("pxpipe.openDashboard")).not.toBeInTheDocument();
	});

	it("toggles the feature on when the switch is clicked", async () => {
		const user = userEvent.setup();
		const { onToggle } = renderSection(false);
		await user.click(screen.getByRole("switch"));
		expect(onToggle).toHaveBeenCalledWith(true);
	});

	it("shows the running state, Stop, and the dashboard link when the proxy is up", async () => {
		(api.request.pxpipeProxyStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
			makeStatus({ portInUse: true, running: true, holderPid: 1234 }),
		);
		renderSection(true);
		expect(await screen.findByText("pxpipe.statusRunning")).toBeInTheDocument();
		expect(screen.getByText("pxpipe.stop")).toBeInTheDocument();
		// The dashboard link is surfaced only inside the running-state block.
		expect(screen.getByText("pxpipe.openDashboard").closest("a")).toHaveAttribute(
			"href",
			"http://127.0.0.1:47821/",
		);
	});

	it("flags a foreign port conflict and disables Start", async () => {
		(api.request.pxpipeProxyStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
			makeStatus({ portInUse: true, foreignConflict: true, holderName: "grafana", holderPid: 42 }),
		);
		renderSection(true);
		expect(await screen.findByText("pxpipe.statusForeign")).toBeInTheDocument();
		expect(screen.getByText("pxpipe.start")).toBeDisabled();
	});
});
