import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GitPullButton from "../GitPullButton";
import { I18nProvider } from "../../i18n";
import type { Project } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getProjectCurrentBranch: vi.fn(),
			pullProjectMain: vi.fn(),
		},
	},
}));

import { api } from "../../rpc";

const project: Project = {
	id: "p1",
	name: "Test Project",
	path: "/tmp/test",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

async function renderButton() {
	let result: ReturnType<typeof render>;
	await act(async () => {
		result = render(
			<I18nProvider>
				<GitPullButton project={project} />
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

	it("calls pullProjectMain and shows success alert on success", async () => {
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
		const alertSpy = alertMock;
		await renderButton();
		const btn = await screen.findByTestId("git-pull-button");
		await waitFor(() => expect(btn).not.toBeDisabled());
		await userEvent.click(btn);
		await waitFor(() => expect(api.request.pullProjectMain).toHaveBeenCalledWith({ projectId: "p1" }));
		await waitFor(() => expect(alertSpy).toHaveBeenCalled());
		const alertText = alertSpy.mock.calls[0][0] as string;
		expect(alertText).toMatch(/main/);
		expect(alertText).toMatch(/Already up to date/);
	});

	it("shows failure alert when pullProjectMain reports ok=false", async () => {
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
		const alertSpy = alertMock;
		await renderButton();
		const btn = await screen.findByTestId("git-pull-button");
		await waitFor(() => expect(btn).not.toBeDisabled());
		await userEvent.click(btn);
		await waitFor(() => expect(alertSpy).toHaveBeenCalled());
		const alertText = alertSpy.mock.calls[0][0] as string;
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
