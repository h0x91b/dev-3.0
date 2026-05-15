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

	it("is enabled when the project is on main", async () => {
		(api.request.getProjectCurrentBranch as any).mockResolvedValue({
			branch: "main",
			isBaseBranch: true,
			isDirty: false,
		});
		await renderButton();
		const btn = await screen.findByTestId("git-pull-button");
		await waitFor(() => expect(btn).not.toBeDisabled());
		expect(btn.getAttribute("title") || "").toMatch(/main/);
	});

	it("is enabled when the project is on master", async () => {
		(api.request.getProjectCurrentBranch as any).mockResolvedValue({
			branch: "master",
			isBaseBranch: false,
			isDirty: false,
		});
		await renderButton();
		const btn = await screen.findByTestId("git-pull-button");
		await waitFor(() => expect(btn).not.toBeDisabled());
	});

	it("is disabled on feature branches", async () => {
		(api.request.getProjectCurrentBranch as any).mockResolvedValue({
			branch: "feat/dev3-something",
			isBaseBranch: false,
			isDirty: false,
		});
		await renderButton();
		const btn = await screen.findByTestId("git-pull-button");
		await waitFor(() =>
			expect(btn.getAttribute("title") || "").toMatch(/feat\/dev3-something/),
		);
		expect(btn).toBeDisabled();
	});

	it("is disabled on detached HEAD", async () => {
		(api.request.getProjectCurrentBranch as any).mockResolvedValue({
			branch: null,
			isBaseBranch: true,
			isDirty: false,
		});
		await renderButton();
		const btn = await screen.findByTestId("git-pull-button");
		await waitFor(() => expect(btn).toBeDisabled());
		expect(btn.getAttribute("title") || "").toMatch(/detached|Detached/);
	});

	it("flashes 'Up to date' on the button and does NOT alert when already up to date", async () => {
		(api.request.getProjectCurrentBranch as any).mockResolvedValue({
			branch: "main",
			isBaseBranch: true,
			isDirty: false,
		});
		(api.request.pullProjectMain as any).mockResolvedValue({
			ok: true,
			branch: "main",
			output: "Already up to date.",
			error: "",
		});
		await renderButton();
		const btn = await screen.findByTestId("git-pull-button");
		await waitFor(() => expect(btn).not.toBeDisabled());
		await userEvent.click(btn);
		await waitFor(() => expect(api.request.pullProjectMain).toHaveBeenCalledWith({ projectId: "p1" }));
		await waitFor(() => expect(btn.getAttribute("data-pull-flash")).toBe("up-to-date"));
		expect(btn.textContent || "").toMatch(/Up to date/i);
		expect(alertMock).not.toHaveBeenCalled();
	});

	it("flashes 'Pulled' on the button and does NOT alert when commits were pulled", async () => {
		(api.request.getProjectCurrentBranch as any).mockResolvedValue({
			branch: "main",
			isBaseBranch: true,
			isDirty: false,
		});
		(api.request.pullProjectMain as any).mockResolvedValue({
			ok: true,
			branch: "main",
			output: "Updating abc..def\nFast-forward\n src/x.ts | 2 ++\n",
			error: "",
		});
		await renderButton();
		const btn = await screen.findByTestId("git-pull-button");
		await waitFor(() => expect(btn).not.toBeDisabled());
		await userEvent.click(btn);
		await waitFor(() => expect(btn.getAttribute("data-pull-flash")).toBe("pulled"));
		expect(btn.textContent || "").toMatch(/Pulled/);
		expect(alertMock).not.toHaveBeenCalled();
	});

	it("flashes 'Failed' and opens the error modal with the error text when pullProjectMain reports ok=false", async () => {
		(api.request.getProjectCurrentBranch as any).mockResolvedValue({
			branch: "main",
			isBaseBranch: true,
			isDirty: false,
		});
		(api.request.pullProjectMain as any).mockResolvedValue({
			ok: false,
			branch: "main",
			output: "",
			error: "fatal: unable to access origin",
		});
		await renderButton();
		const btn = await screen.findByTestId("git-pull-button");
		await waitFor(() => expect(btn).not.toBeDisabled());
		await userEvent.click(btn);
		await waitFor(() => expect(btn.getAttribute("data-pull-flash")).toBe("failed"));
		expect(btn.textContent || "").toMatch(/Failed/);
		// New behaviour: a modal opens instead of alert()
		const errorText = await screen.findByTestId("git-pull-error-text");
		expect(errorText.textContent || "").toMatch(/fatal: unable to access origin/);
		expect(alertMock).not.toHaveBeenCalled();
	});

	it("retries the pull when the retry button is clicked", async () => {
		(api.request.getProjectCurrentBranch as any).mockResolvedValue({
			branch: "main",
			isBaseBranch: true,
			isDirty: false,
		});
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
		await waitFor(() => expect(btn).not.toBeDisabled());
		await userEvent.click(btn);
		const retry = await screen.findByTestId("git-pull-error-retry");
		await userEvent.click(retry);
		await waitFor(() => expect(api.request.pullProjectMain).toHaveBeenCalledTimes(2));
		// On success the modal closes
		await waitFor(() => expect(screen.queryByTestId("git-pull-error-text")).toBeNull());
		await waitFor(() => expect(btn.getAttribute("data-pull-flash")).toBe("up-to-date"));
	});

	it("clears the success flash and error modal when projectId changes (project switch)", async () => {
		(api.request.getProjectCurrentBranch as any).mockResolvedValue({
			branch: "main",
			isBaseBranch: true,
			isDirty: false,
		});
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
		await waitFor(() => expect(btn).not.toBeDisabled());
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
			expect(screen.getByTestId("git-pull-button").getAttribute("data-pull-flash")).toBeNull(),
		);
	});

	it("clears the error modal when projectId changes (project switch)", async () => {
		(api.request.getProjectCurrentBranch as any).mockResolvedValue({
			branch: "main",
			isBaseBranch: true,
			isDirty: false,
		});
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
		await waitFor(() => expect(btn).not.toBeDisabled());
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
		(api.request.getProjectCurrentBranch as any).mockResolvedValue({
			branch: "main",
			isBaseBranch: true,
			isDirty: false,
		});
		(api.request.pullProjectMain as any).mockResolvedValue({
			ok: false,
			branch: "main",
			output: "",
			error: "boom",
		});
		await renderButton();
		const btn = await screen.findByTestId("git-pull-button");
		await waitFor(() => expect(btn).not.toBeDisabled());
		await userEvent.click(btn);
		const errorText = await screen.findByTestId("git-pull-error-text");
		expect(errorText).toBeTruthy();
		const closeBtn = screen.getAllByRole("button").find((b) => b.textContent?.trim() === "Close");
		expect(closeBtn).toBeTruthy();
		await userEvent.click(closeBtn!);
		await waitFor(() => expect(screen.queryByTestId("git-pull-error-text")).toBeNull());
	});

	it("does not call pullProjectMain when disabled", async () => {
		(api.request.getProjectCurrentBranch as any).mockResolvedValue({
			branch: "develop",
			isBaseBranch: false,
			isDirty: false,
		});
		await renderButton();
		const btn = await screen.findByTestId("git-pull-button");
		await waitFor(() => expect(btn).toBeDisabled());
		await userEvent.click(btn);
		expect(api.request.pullProjectMain).not.toHaveBeenCalled();
	});
});
