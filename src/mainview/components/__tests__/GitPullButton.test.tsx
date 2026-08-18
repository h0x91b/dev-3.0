import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GitPullButton from "../GitPullButton";
import { I18nProvider } from "../../i18n";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getProjectCurrentBranch: vi.fn(),
			pullProjectMain: vi.fn(),
		},
	},
}));

import { api } from "../../rpc";

/** The button only renders when there is something to pull, so `behindOrigin` defaults to a hit. */
function mockBranch(branch: string | null, behindOrigin = 2) {
	(api.request.getProjectCurrentBranch as any).mockResolvedValue({
		branch,
		isBaseBranch: branch === "main",
		isDirty: false,
		behindOrigin,
	});
}

async function renderButton() {
	let result: ReturnType<typeof render>;
	await act(async () => {
		result = render(
			<I18nProvider>
				<GitPullButton projectId="p1" />
			</I18nProvider>,
		);
	});
	return result!;
}

describe("GitPullButton", () => {
	let alertMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		alertMock = vi.fn();
		// happy-dom does not provide window.alert — install our own
		(window as any).alert = alertMock;
	});

	// ── Visibility: nothing to pull → nothing on screen ───────────────────────

	it("renders on main when origin has new commits", async () => {
		mockBranch("main", 3);
		await renderButton();
		const btn = await screen.findByTestId("git-pull-button");
		expect(btn).toHaveAttribute("aria-disabled", "false");
		expect(btn.getAttribute("aria-label") || "").toMatch(/main/);
	});

	it("renders on master when origin has new commits", async () => {
		mockBranch("master", 1);
		await renderButton();
		expect(await screen.findByTestId("git-pull-button")).toHaveAttribute("aria-disabled", "false");
	});

	it("is not rendered when local main is up to date", async () => {
		mockBranch("main", 0);
		await renderButton();
		await waitFor(() => expect(api.request.getProjectCurrentBranch).toHaveBeenCalled());
		expect(screen.queryByTestId("git-pull-button")).toBeNull();
	});

	it("is not rendered on a feature branch", async () => {
		mockBranch("feat/dev3-something", 0);
		await renderButton();
		await waitFor(() => expect(api.request.getProjectCurrentBranch).toHaveBeenCalled());
		expect(screen.queryByTestId("git-pull-button")).toBeNull();
	});

	it("is not rendered on detached HEAD", async () => {
		mockBranch(null, 0);
		await renderButton();
		await waitFor(() => expect(api.request.getProjectCurrentBranch).toHaveBeenCalled());
		expect(screen.queryByTestId("git-pull-button")).toBeNull();
	});

	it("is not rendered before the branch is known", () => {
		(api.request.getProjectCurrentBranch as any).mockReturnValue(new Promise(() => {}));
		render(
			<I18nProvider>
				<GitPullButton projectId="p1" />
			</I18nProvider>,
		);
		expect(screen.queryByTestId("git-pull-button")).toBeNull();
	});

	// ── Pull outcomes ─────────────────────────────────────────────────────────

	it("flashes 'Up to date' on the button and does NOT alert when already up to date", async () => {
		mockBranch("main");
		(api.request.pullProjectMain as any).mockResolvedValue({
			ok: true,
			branch: "main",
			output: "Already up to date.",
			error: "",
		});
		await renderButton();
		const btn = await screen.findByTestId("git-pull-button");
		await userEvent.click(btn);
		await waitFor(() => expect(api.request.pullProjectMain).toHaveBeenCalledWith({ projectId: "p1" }));
		await waitFor(() => expect(btn.getAttribute("data-pull-flash")).toBe("up-to-date"));
		expect(btn.textContent || "").toMatch(/Up to date/i);
		expect(alertMock).not.toHaveBeenCalled();
	});

	it("flashes 'Pulled' on the button and does NOT alert when commits were pulled", async () => {
		mockBranch("main");
		(api.request.pullProjectMain as any).mockResolvedValue({
			ok: true,
			branch: "main",
			output: "Updating abc..def\nFast-forward\n src/x.ts | 2 ++\n",
			error: "",
		});
		await renderButton();
		const btn = await screen.findByTestId("git-pull-button");
		await userEvent.click(btn);
		await waitFor(() => expect(btn.getAttribute("data-pull-flash")).toBe("pulled"));
		expect(btn.textContent || "").toMatch(/Pulled/);
		expect(alertMock).not.toHaveBeenCalled();
	});

	it("shows the shared SVG spinner while a pull is in progress", async () => {
		mockBranch("main");
		let resolvePull: (v: any) => void = () => {};
		(api.request.pullProjectMain as any).mockReturnValue(
			new Promise((res) => {
				resolvePull = res;
			}),
		);
		await renderButton();
		const btn = await screen.findByTestId("git-pull-button");
		await userEvent.click(btn);
		// While pulling we show the same SVG spinner as the "checking for updates" header
		// indicator instead of a spinning Nerd Font glyph — it spins cleanly around its own
		// center (no wobble) and carries no text content.
		const spinner = await screen.findByTestId("git-pull-spinner");
		expect(spinner.tagName.toLowerCase()).toBe("svg");
		expect(spinner.textContent).toBe("");
		// Same markup as the "checking for updates" header spinner: a circle track + arc.
		expect(spinner.querySelector("circle")).not.toBeNull();
		expect(spinner.querySelector("path")).not.toBeNull();
		const spinnerClass = spinner.getAttribute("class") ?? "";
		expect(spinnerClass).toMatch(/w-3\.5/);
		expect(spinnerClass).toMatch(/h-3\.5/);
		// Settle the pending promise to avoid act() warnings.
		await act(async () => {
			resolvePull({ ok: true, branch: "main", output: "Already up to date.", error: "" });
		});
		await waitFor(() => expect(btn.getAttribute("data-pull-flash")).toBe("up-to-date"));
	});

	it("flashes 'Failed' and opens the error modal with the error text when pullProjectMain reports ok=false", async () => {
		mockBranch("main");
		(api.request.pullProjectMain as any).mockResolvedValue({
			ok: false,
			branch: "main",
			output: "",
			error: "fatal: unable to access origin",
		});
		await renderButton();
		const btn = await screen.findByTestId("git-pull-button");
		await userEvent.click(btn);
		await waitFor(() => expect(btn.getAttribute("data-pull-flash")).toBe("failed"));
		expect(btn.textContent || "").toMatch(/Failed/);
		// New behaviour: a modal opens instead of alert()
		const errorText = await screen.findByTestId("git-pull-error-text");
		expect(errorText.textContent || "").toMatch(/fatal: unable to access origin/);
		expect(alertMock).not.toHaveBeenCalled();
	});

	it("retries the pull when the retry button is clicked", async () => {
		mockBranch("main");
		(api.request.pullProjectMain as any)
			.mockResolvedValueOnce({
				ok: false,
				branch: "main",
				output: "",
				error: "fatal: network is unreachable",
			})
			.mockResolvedValueOnce({
				ok: true,
				branch: "main",
				output: "Already up to date.",
				error: "",
			});
		await renderButton();
		const btn = await screen.findByTestId("git-pull-button");
		await userEvent.click(btn);
		const retry = await screen.findByTestId("git-pull-error-retry");
		await userEvent.click(retry);
		await waitFor(() => expect(api.request.pullProjectMain).toHaveBeenCalledTimes(2));
		// On success the modal closes
		await waitFor(() => expect(screen.queryByTestId("git-pull-error-text")).toBeNull());
		await waitFor(() => expect(btn.getAttribute("data-pull-flash")).toBe("up-to-date"));
	});

	it("clears the success flash and error modal when projectId changes (project switch)", async () => {
		mockBranch("main");
		(api.request.pullProjectMain as any).mockResolvedValue({
			ok: true,
			branch: "main",
			output: "Updating abc..def\nFast-forward\n",
			error: "",
		});
		let rerender: ReturnType<typeof render>["rerender"];
		await act(async () => {
			const r = render(
				<I18nProvider>
					<GitPullButton projectId="p1" />
				</I18nProvider>,
			);
			rerender = r.rerender;
		});
		const btn = await screen.findByTestId("git-pull-button");
		await userEvent.click(btn);
		await waitFor(() => expect(btn.getAttribute("data-pull-flash")).toBe("pulled"));
		// Switch project — flash must reset immediately, not stick around for 3 seconds
		await act(async () => {
			rerender!(
				<I18nProvider>
					<GitPullButton projectId="p2" />
				</I18nProvider>,
			);
		});
		await waitFor(() =>
			expect(screen.queryByTestId("git-pull-button")?.getAttribute("data-pull-flash") ?? null).toBeNull(),
		);
	});

	it("clears the error modal when projectId changes (project switch)", async () => {
		mockBranch("main");
		(api.request.pullProjectMain as any).mockResolvedValue({
			ok: false,
			branch: "main",
			output: "",
			error: "fatal: boom",
		});
		let rerender: ReturnType<typeof render>["rerender"];
		await act(async () => {
			const r = render(
				<I18nProvider>
					<GitPullButton projectId="p1" />
				</I18nProvider>,
			);
			rerender = r.rerender;
		});
		const btn = await screen.findByTestId("git-pull-button");
		await userEvent.click(btn);
		await screen.findByTestId("git-pull-error-text");
		await act(async () => {
			rerender!(
				<I18nProvider>
					<GitPullButton projectId="p2" />
				</I18nProvider>,
			);
		});
		await waitFor(() => expect(screen.queryByTestId("git-pull-error-text")).toBeNull());
	});

	it("closes the error modal when Close is clicked", async () => {
		mockBranch("main");
		(api.request.pullProjectMain as any).mockResolvedValue({
			ok: false,
			branch: "main",
			output: "",
			error: "boom",
		});
		await renderButton();
		const btn = await screen.findByTestId("git-pull-button");
		await userEvent.click(btn);
		const errorText = await screen.findByTestId("git-pull-error-text");
		expect(errorText).toBeTruthy();
		const closeBtn = screen.getAllByRole("button").find((b) => b.textContent?.trim() === "Close");
		expect(closeBtn).toBeTruthy();
		await userEvent.click(closeBtn!);
		await waitFor(() => expect(screen.queryByTestId("git-pull-error-text")).toBeNull());
	});

	// ── Behind-origin hint ────────────────────────────────────────────────────

	it("shows the behind-origin dot and accent tint when remote has new commits", async () => {
		mockBranch("main", 3);
		await renderButton();
		const btn = await screen.findByTestId("git-pull-button");
		await waitFor(() => expect(btn.getAttribute("data-behind-origin")).toBe("3"));
		expect(screen.getByTestId("git-pull-behind-dot")).toBeTruthy();
		expect(btn.className).toMatch(/text-accent/);
		expect(btn.getAttribute("aria-label") || "").toMatch(/3 new commits on origin\/main/);
	});

	it("stays mounted through the flash after a pull zeroes the behind count", async () => {
		mockBranch("main", 2);
		(api.request.pullProjectMain as any).mockResolvedValue({
			ok: true,
			branch: "main",
			output: "Updating abc..def\nFast-forward\n",
			error: "",
		});
		await renderButton();
		const btn = await screen.findByTestId("git-pull-button");
		await waitFor(() => expect(btn.getAttribute("data-behind-origin")).toBe("2"));
		// refreshBranch after pull reports 0 behind
		mockBranch("main", 0);
		await userEvent.click(btn);
		await waitFor(() => expect(btn.getAttribute("data-pull-flash")).toBe("pulled"));
		expect(btn.getAttribute("data-behind-origin")).toBeNull();
		expect(screen.queryByTestId("git-pull-behind-dot")).toBeNull();
	});
});
