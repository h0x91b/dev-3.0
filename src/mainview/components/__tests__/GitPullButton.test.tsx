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

	it("flashes 'Pulled' and shows alert with details when commits were pulled", async () => {
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
		await waitFor(() => expect(alertMock).toHaveBeenCalled());
		const alertText = alertMock.mock.calls[0][0] as string;
		expect(alertText).toMatch(/Fast-forward/);
	});

	it("flashes 'Failed' and shows failure alert when pullProjectMain reports ok=false", async () => {
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
		await waitFor(() => expect(alertMock).toHaveBeenCalled());
		const alertText = alertMock.mock.calls[0][0] as string;
		expect(alertText).toMatch(/failed|Pull failed/i);
		expect(alertText).toMatch(/fatal: unable to access origin/);
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
