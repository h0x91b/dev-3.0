import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../i18n";
import TrafficTerminalPeek from "../components/agent-traffic/TrafficTerminalPeek";
import type { TaskPeekSnapshot } from "../../shared/task-peek";
import { api } from "../rpc";

vi.mock("../rpc", () => ({
	api: { request: { peekTaskTerminal: vi.fn() } },
}));

const peek = api.request.peekTaskTerminal as unknown as ReturnType<typeof vi.fn>;

function snapshot(over: Partial<TaskPeekSnapshot> = {}): TaskPeekSnapshot {
	return {
		taskId: "task-a",
		seq: 11,
		title: "A task",
		status: "in-progress",
		backend: "tmux",
		observedAt: new Date().toISOString(),
		sessionPresent: true,
		unavailable: null,
		panes: [
			{
				index: 1,
				paneId: "%1",
				label: "claude",
				alive: true,
				focused: true,
				lastOutputAt: null,
				lastOutputAgeMs: null,
				granularity: "window",
			},
		],
		tail: { paneIndex: 1, paneId: "%1", lines: 2, text: "> running tests\nall green" },
		...over,
	};
}

function renderPeek(taskId = "task-a") {
	return render(
		<I18nProvider>
			<TrafficTerminalPeek taskId={taskId} projectId="proj-1" />
		</I18nProvider>,
	);
}

beforeEach(() => {
	peek.mockReset();
});

it("reads nothing until the user asks, then shows the tail", async () => {
	peek.mockResolvedValue(snapshot());
	renderPeek();

	expect(peek).not.toHaveBeenCalled();

	await userEvent.click(screen.getByRole("button", { name: /Terminal snapshot/ }));

	expect(await screen.findByText(/all green/)).toBeTruthy();
	expect(peek).toHaveBeenCalledWith(
		expect.objectContaining({ taskId: "task-a", projectId: "proj-1" }),
	);
});

it("never calls the snapshot a screenshot", async () => {
	peek.mockResolvedValue(snapshot());
	renderPeek();
	await userEvent.click(screen.getByRole("button", { name: /Terminal snapshot/ }));

	await screen.findByText(/all green/);
	expect(screen.getByText(/not a picture of it/)).toBeTruthy();
	expect(document.body.textContent ?? "").not.toMatch(/screenshot/i);
});

it("drops an answer that is about a different task", async () => {
	peek.mockResolvedValue(snapshot({ taskId: "task-OTHER", tail: { paneIndex: 1, paneId: "%1", lines: 1, text: "secret from elsewhere" } }));
	renderPeek("task-a");
	await userEvent.click(screen.getByRole("button", { name: /Terminal snapshot/ }));

	await waitFor(() => expect(peek).toHaveBeenCalled());
	expect(screen.queryByText(/secret from elsewhere/)).toBeNull();
});

it("says a failed read proves nothing about the task", async () => {
	peek.mockResolvedValue(
		snapshot({
			tail: null,
			unavailable: { kind: "read-failed", detail: "unreadable: the record could not be parsed" },
		}),
	);
	renderPeek();
	await userEvent.click(screen.getByRole("button", { name: /Terminal snapshot/ }));

	expect(await screen.findByText(/says nothing about whether the task is working/)).toBeTruthy();
	expect(screen.getByText(/unreadable: the record could not be parsed/)).toBeTruthy();
});

it("explains a backend that publishes no screen in plain words, with the token underneath", async () => {
	peek.mockResolvedValue(
		snapshot({
			backend: "native",
			tail: null,
			unavailable: { kind: "read-failed", detail: "not-enabled: the host's live parser is off" },
		}),
	);
	renderPeek();
	await userEvent.click(screen.getByRole("button", { name: /Terminal snapshot/ }));

	// Plain sentence, because "could not read it" invites a retry that will never
	// work here. The backend's own token stays as secondary diagnostic text.
	expect(await screen.findByText(/publishes no screen to read/)).toBeTruthy();
	expect(screen.queryByText(/says nothing about whether the task is working/)).toBeNull();
	expect(screen.getByText(/not-enabled: the host's live parser is off/)).toBeTruthy();
});

it("distinguishes a missing session from a failed read", async () => {
	peek.mockResolvedValue(
		snapshot({
			sessionPresent: false,
			panes: [],
			tail: null,
			unavailable: { kind: "no-session", detail: "task is hibernated" },
		}),
	);
	renderPeek();
	await userEvent.click(screen.getByRole("button", { name: /Terminal snapshot/ }));

	expect(await screen.findByText(/No terminal session — task is hibernated/)).toBeTruthy();
	expect(screen.queryByText(/says nothing about whether/)).toBeNull();
	// Nothing was read, so the "this is text" claim and the pane line have nothing
	// to describe — and the bare backend name is not a fallback for either.
	expect(screen.queryByText(/not a picture of it/)).toBeNull();
	expect(document.body.textContent ?? "").not.toMatch(/tmux/);
});

it("offers pane chips only when the task has more than one pane", async () => {
	peek.mockResolvedValue(snapshot());
	renderPeek();
	await userEvent.click(screen.getByRole("button", { name: /Terminal snapshot/ }));
	await screen.findByText(/all green/);
	expect(screen.queryByRole("button", { name: "claude" })).toBeNull();

	peek.mockResolvedValue(
		snapshot({
			panes: [
				...snapshot().panes,
				{
					index: 2,
					paneId: "%2",
					label: "watch",
					alive: true,
					focused: false,
					lastOutputAt: null,
					lastOutputAgeMs: null,
					granularity: "window",
				},
			],
		}),
	);
	await userEvent.click(screen.getByRole("button", { name: /Refresh/ }));

	const chip = await screen.findByRole("button", { name: "watch" });
	await userEvent.click(chip);
	await waitFor(() =>
		expect(peek).toHaveBeenLastCalledWith(expect.objectContaining({ pane: "%2" })),
	);
});
