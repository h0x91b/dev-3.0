import { act, fireEvent, render, screen } from "@testing-library/react";
import type { AutoHibernateSuggestion } from "../../shared/auto-hibernate";
import AutoHibernateSuggestionModal from "../components/AutoHibernateSuggestionModal";
import { I18nProvider } from "../i18n";
import { setDialogKeyboardGuardClock } from "../utils/dialog-keyboard-guard";

const now = new Date("2026-11-01T10:00:00Z").getTime();
function suggestion(overrides: Partial<AutoHibernateSuggestion> = {}): AutoHibernateSuggestion {
	return {
		id: "suggestion-1", held: false, autoConfirmAt: now + 30_000,
		tasks: [
			{ taskId: "task-1", projectId: "project-1", title: "Fix the parser", projectName: "Compiler", lastActivityAt: now - 120 * 60_000, timeoutMinutes: 60 },
			{ taskId: "task-2", projectId: "project-2", title: "Refresh the docs", projectName: "Website", lastActivityAt: now - 90 * 60_000, timeoutMinutes: 60 },
		], ...overrides,
	};
}
function setup(value = suggestion(), respond = vi.fn(async () => {})) {
	const onPresent = vi.fn();
	const onHold = vi.fn();
	const props = { suggestion: value, onPresent, onHold, onRespond: respond };
	const result = render(<I18nProvider><AutoHibernateSuggestionModal {...props} /></I18nProvider>);
	return { ...result, ...props, rerenderSuggestion: (next: AutoHibernateSuggestion) => result.rerender(<I18nProvider><AutoHibernateSuggestionModal {...props} suggestion={next} /></I18nProvider>) };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(now);
	setDialogKeyboardGuardClock(() => Date.now());
});
afterEach(() => {
	vi.useRealTimers();
	setDialogKeyboardGuardClock(null);
});

it("presents the whole group once, autofocuses Not now, and keeps the unattended countdown armed", () => {
	const { onPresent, onHold, rerenderSuggestion } = setup();
	expect(onPresent).toHaveBeenCalledTimes(1);
	expect(screen.getByRole("button", { name: "Not now" })).toHaveFocus();
	expect(onHold).not.toHaveBeenCalled();
	expect(screen.getByRole("checkbox", { name: /Fix the parser/ })).toBeChecked();
	expect(screen.getByRole("checkbox", { name: /Refresh the docs/ })).toBeChecked();
	expect(screen.getByText("Compiler")).toBeInTheDocument();
	expect(screen.getByText("Website")).toBeInTheDocument();
	expect(screen.getByText("Inactive for 120 minutes")).toBeInTheDocument();
	expect(screen.getByText(/terminal scrollback/i)).toBeInTheDocument();
	expect(screen.getByText(/worktrees, files and conversations/)).toBeInTheDocument();
	rerenderSuggestion(suggestion({ autoConfirmAt: now + 60_000 }));
	expect(onPresent).toHaveBeenCalledTimes(1);
	expect(onHold).not.toHaveBeenCalled();
});

it("renders the host deadline and never executes a hibernation from a client timer", () => {
	const { onRespond } = setup();
	expect(screen.getByTestId("auto-hibernate-countdown")).toHaveTextContent("0:30");
	act(() => vi.advanceTimersByTime(10_000));
	expect(screen.getByTestId("auto-hibernate-countdown")).toHaveTextContent("0:20");
	act(() => vi.advanceTimersByTime(30_000));
	expect(onRespond).not.toHaveBeenCalled();
});

it("holds once for pointer, key and wheel activity without rearming after a deadline update", () => {
	const { onHold, rerenderSuggestion } = setup();
	fireEvent.pointerDown(screen.getByRole("dialog"));
	fireEvent.wheel(screen.getByRole("dialog"));
	fireEvent.keyDown(screen.getByRole("dialog"), { key: "x" });
	expect(onHold).toHaveBeenCalledTimes(1);
	expect(screen.queryByTestId("auto-hibernate-countdown")).not.toBeInTheDocument();
	rerenderSuggestion(suggestion({ autoConfirmAt: now + 60_000 }));
	expect(screen.queryByTestId("auto-hibernate-countdown")).not.toBeInTheDocument();
	expect(screen.getByText(/paused/)).toBeInTheDocument();
});

it("holds for swallowed keys before the unsolicited dialog is armed", () => {
	const { onHold, onRespond } = setup();
	fireEvent.keyDown(screen.getByRole("button", { name: "Not now" }), { key: "Enter" });
	expect(onHold).toHaveBeenCalledTimes(1);
	expect(onRespond).not.toHaveBeenCalled();
});

it("reflects a hold from another client and does not send a redundant hold", () => {
	const { rerenderSuggestion, onHold } = setup();
	rerenderSuggestion(suggestion({ held: true, autoConfirmAt: null }));
	expect(screen.queryByTestId("auto-hibernate-countdown")).not.toBeInTheDocument();
	fireEvent.wheel(screen.getByRole("dialog"));
	expect(onHold).not.toHaveBeenCalled();
});

it("holds before changing selection and submits only checked live tasks", async () => {
	const { onHold, onRespond, rerenderSuggestion } = setup();
	fireEvent.click(screen.getByRole("checkbox", { name: /Refresh the docs/ }));
	expect(onHold).toHaveBeenCalledTimes(1);
	expect(screen.getByRole("checkbox", { name: /Refresh the docs/ })).not.toBeChecked();
	rerenderSuggestion(suggestion({ tasks: [suggestion().tasks[0]], held: true, autoConfirmAt: null }));
	expect(screen.queryByRole("checkbox", { name: /Refresh the docs/ })).not.toBeInTheDocument();
	await act(async () => fireEvent.click(screen.getByRole("button", { name: "Hibernate selected (1)" })));
	expect(onRespond).toHaveBeenCalledWith("hibernate", ["task-1"]);
});

it("disables hibernation for an empty selection and Not now snoozes the whole group", async () => {
	const { onRespond } = setup();
	fireEvent.click(screen.getByRole("checkbox", { name: /Fix the parser/ }));
	fireEvent.click(screen.getByRole("checkbox", { name: /Refresh the docs/ }));
	expect(screen.getByRole("button", { name: "Hibernate selected (0)" })).toBeDisabled();
	await act(async () => fireEvent.click(screen.getByRole("button", { name: "Not now" })));
	expect(onRespond).toHaveBeenCalledWith("snooze", ["task-1", "task-2"]);
});

it("Escape snoozes after the keyboard quiet window", async () => {
	const { onRespond } = setup();
	act(() => vi.advanceTimersByTime(1_000));
	await act(async () => fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" }));
	expect(onRespond).toHaveBeenCalledWith("snooze", ["task-1", "task-2"]);
});

it("prevents duplicate responses while pending and remains usable when the host reports an error", async () => {
	let reject: (error: Error) => void = () => {};
	const onRespond = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
	setup(suggestion(), onRespond);
	fireEvent.click(screen.getByRole("button", { name: "Hibernate selected (2)" }));
	fireEvent.click(screen.getByRole("button", { name: "Not now" }));
	expect(onRespond).toHaveBeenCalledTimes(1);
	await act(async () => reject(new Error("Connection lost")));
	expect(screen.getByRole("button", { name: "Not now" })).toBeEnabled();
});


it("does not treat a cursor passing over the dialog or a focus update as interaction", () => {
	const { onHold } = setup();
	fireEvent.pointerMove(screen.getByRole("dialog"));
	fireEvent.focus(screen.getByRole("checkbox", { name: /Fix the parser/ }));
	expect(onHold).not.toHaveBeenCalled();
	expect(screen.getByTestId("auto-hibernate-countdown")).toBeInTheDocument();
});

it("never rearms a remote hold when a stale unheld push arrives", () => {
	const { rerenderSuggestion } = setup();
	rerenderSuggestion(suggestion({ held: true, autoConfirmAt: null }));
	rerenderSuggestion(suggestion({ held: false, autoConfirmAt: now + 60_000 }));
	expect(screen.queryByTestId("auto-hibernate-countdown")).not.toBeInTheDocument();
});

it("resets the selection and presents again when a new suggestion replaces the old one", () => {
	const { onPresent, onHold, rerenderSuggestion } = setup();
	fireEvent.click(screen.getByRole("checkbox", { name: /Fix the parser/ }));
	rerenderSuggestion(suggestion({ id: "suggestion-2" }));
	expect(onPresent).toHaveBeenCalledTimes(2);
	expect(onHold).toHaveBeenCalledTimes(1);
	expect(screen.getByRole("checkbox", { name: /Fix the parser/ })).toBeChecked();
	expect(screen.getByTestId("auto-hibernate-countdown")).toBeInTheDocument();
});
