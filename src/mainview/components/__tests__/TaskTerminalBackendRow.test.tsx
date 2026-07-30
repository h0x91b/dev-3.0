import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskTerminalBackendRow from "../TaskTerminalBackendRow";
import { I18nProvider } from "../../i18n";
import type { NativeTerminalAvailability, Project, Task, TaskTerminalBackendInfo } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getTaskTerminalBackend: vi.fn(),
			getNativeTerminalAvailability: vi.fn(),
			setTaskTerminalBackend: vi.fn(),
		},
	},
}));

vi.mock("../../toast", () => ({
	toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import { api } from "../../rpc";
import { toast } from "../../toast";

const mockedApi = vi.mocked(api, true);

const project = { id: "p1", name: "P", path: "/p" } as Project;
const task = { id: "t1", projectId: "p1", title: "T", status: "todo" } as Task;

function setup(
	info: TaskTerminalBackendInfo,
	availability: NativeTerminalAvailability = { available: true, tmuxSupported: true, diagnostics: [] },
) {
	mockedApi.request.getTaskTerminalBackend.mockResolvedValue(info);
	mockedApi.request.getNativeTerminalAvailability.mockResolvedValue(availability);
	const dispatch = vi.fn();
	render(
		<I18nProvider>
			<TaskTerminalBackendRow task={task} project={project} dispatch={dispatch} />
		</I18nProvider>,
	);
	return { dispatch };
}

function option(name: RegExp): HTMLElement {
	return screen.getByRole("radio", { name });
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("TaskTerminalBackendRow", () => {
	it("shows the effective backend of an unmarked task as tmux, flagged as the default", async () => {
		setup({ backend: "tmux", explicit: false, liveBackend: null });
		await waitFor(() => expect(option(/tmux/)).toHaveAttribute("aria-checked", "true"));
		expect(option(/native/)).toHaveAttribute("aria-checked", "false");
		expect(screen.getByText("default")).toBeInTheDocument();
	});

	it("switches a stopped task and pushes the updated task into app state", async () => {
		const updated = { ...task, terminalBackend: "native" as const };
		mockedApi.request.setTaskTerminalBackend.mockResolvedValue(updated);
		const { dispatch } = setup({ backend: "tmux", explicit: false, liveBackend: null });
		await waitFor(() => expect(option(/native/)).toBeEnabled());

		await userEvent.click(option(/native/));

		await waitFor(() =>
			expect(mockedApi.request.setTaskTerminalBackend).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				backend: "native",
			}),
		);
		expect(dispatch).toHaveBeenCalledWith({ type: "updateTask", task: updated });
	});

	// Backend-neutral: the lock reads the same whichever side is alive.
	it.each([
		{ live: "tmux" as const, other: /native/ },
		{ live: "native" as const, other: /tmux/ },
	])("locks the switch while a live $live terminal owns the task", async ({ live, other }) => {
		setup({ backend: live, explicit: true, liveBackend: live });
		await waitFor(() => expect(option(other)).toBeDisabled());

		await userEvent.click(option(other));
		expect(mockedApi.request.setTaskTerminalBackend).not.toHaveBeenCalled();
		expect(screen.getByText(/stop it before switching/i)).toBeInTheDocument();
	});

	it("disables native and explains why when this build has no native host", async () => {
		setup({ backend: "tmux", explicit: false, liveBackend: null }, {
			available: false,
			tmuxSupported: true,
			diagnostics: ["Packaged host image unusable: no manifest"],
		});
		await waitFor(() => expect(option(/native/)).toBeDisabled());
		expect(screen.getByText(/cannot launch a native terminal host/i)).toBeInTheDocument();
		expect(mockedApi.request.setTaskTerminalBackend).not.toHaveBeenCalled();
	});

	it("disables tmux on a host without a tmux runtime", async () => {
		setup({ backend: "native", explicit: true, liveBackend: null }, {
			available: true,
			tmuxSupported: false,
			diagnostics: [],
		});
		await waitFor(() => expect(option(/tmux/)).toBeDisabled());
		expect(screen.getByText(/does not run on Windows/i)).toBeInTheDocument();
	});

	it("surfaces a refused switch as an error toast and keeps the old selection", async () => {
		mockedApi.request.setTaskTerminalBackend.mockRejectedValue(new Error("still has a live tmux terminal"));
		setup({ backend: "tmux", explicit: false, liveBackend: null });
		await waitFor(() => expect(option(/native/)).toBeEnabled());

		await userEvent.click(option(/native/));

		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(option(/tmux/)).toHaveAttribute("aria-checked", "true");
	});

	it("moves the selection with the arrow keys on a stopped task", async () => {
		const updated = { ...task, terminalBackend: "native" as const };
		mockedApi.request.setTaskTerminalBackend.mockResolvedValue(updated);
		setup({ backend: "tmux", explicit: false, liveBackend: null });
		await waitFor(() => expect(option(/native/)).toBeEnabled());

		option(/tmux/).focus();
		await userEvent.keyboard("{ArrowRight}");

		await waitFor(() =>
			expect(mockedApi.request.setTaskTerminalBackend).toHaveBeenCalledWith(
				expect.objectContaining({ backend: "native" }),
			),
		);
	});

	it("ignores the arrow keys while a live terminal owns the task", async () => {
		setup({ backend: "tmux", explicit: true, liveBackend: "tmux" });
		await waitFor(() => expect(option(/native/)).toBeDisabled());

		option(/tmux/).focus();
		await userEvent.keyboard("{ArrowRight}");
		expect(mockedApi.request.setTaskTerminalBackend).not.toHaveBeenCalled();
	});

	it("renders nothing until the backend answers", () => {
		mockedApi.request.getTaskTerminalBackend.mockReturnValue(new Promise(() => {}));
		mockedApi.request.getNativeTerminalAvailability.mockReturnValue(new Promise(() => {}));
		const { container } = render(
			<I18nProvider>
				<TaskTerminalBackendRow task={task} project={project} dispatch={vi.fn()} />
			</I18nProvider>,
		);
		expect(container).toBeEmptyDOMElement();
	});
});
