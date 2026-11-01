import { useEffect } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AutoHibernateSuggestion } from "../../shared/auto-hibernate";
import { api } from "../rpc";
import AutoHibernateSuggestions from "../components/AutoHibernateSuggestions";

vi.mock("../rpc", () => ({ api: { request: {
	getAutoHibernateSuggestion: vi.fn(async () => null),
	presentAutoHibernateSuggestion: vi.fn(async () => {}),
	respondAutoHibernateSuggestion: vi.fn(async () => {}),
} } }));
vi.mock("../components/AutoHibernateSuggestionModal", () => ({ default: ({ suggestion, onPresent }: { suggestion: AutoHibernateSuggestion; onPresent(): void }) => {
	useEffect(onPresent, []);
	return <div role="dialog">{suggestion.id}</div>;
} }));

const suggestion: AutoHibernateSuggestion = { id: "offer", tasks: [{ taskId: "task", projectId: "project", title: "Task", projectName: "Project", lastActivityAt: 1, timeoutMinutes: 1440 }], held: false, autoConfirmAt: null };
const push = (value: AutoHibernateSuggestion | null) => act(() => {
	window.dispatchEvent(new CustomEvent("rpc:autoHibernateSuggestionChanged", { detail: { suggestion: value } }));
});
beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	vi.mocked(api.request.getAutoHibernateSuggestion).mockResolvedValue(null);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("replays pending suggestions and acknowledges the visible dialog", async () => {
	vi.mocked(api.request.getAutoHibernateSuggestion).mockResolvedValue(suggestion);
	render(<AutoHibernateSuggestions />);
	expect(await screen.findByRole("dialog")).toHaveTextContent("offer");
	expect(api.request.presentAutoHibernateSuggestion).toHaveBeenCalledWith({ id: "offer" });
	push(null);
	expect(screen.queryByRole("dialog")).toBeNull();
});

it("never starts a countdown in a hidden tab, and displays it when visible", async () => {
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
	render(<AutoHibernateSuggestions />);
	push(suggestion);
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(api.request.presentAutoHibernateSuggestion).not.toHaveBeenCalled();
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	act(() => { document.dispatchEvent(new Event("visibilitychange")); });
	expect(await screen.findByRole("dialog")).toHaveTextContent("offer");
});

it("waits behind other dialogs and holds an already-running timer when blocked", async () => {
	const { rerender } = render(<AutoHibernateSuggestions blocked />);
	push(suggestion);
	expect(api.request.presentAutoHibernateSuggestion).not.toHaveBeenCalled();
	rerender(<AutoHibernateSuggestions />);
	expect(await screen.findByRole("dialog")).toBeInTheDocument();
	push({ ...suggestion, autoConfirmAt: Date.now() + 1000 });
	rerender(<AutoHibernateSuggestions blocked />);
	await waitFor(() => expect(api.request.respondAutoHibernateSuggestion).toHaveBeenCalledWith({ id: "offer", action: "hold", taskIds: [] }));
});

it("does not resurrect a resolved suggestion from a stale reconnect read", async () => {
	let resolve!: (value: AutoHibernateSuggestion | null) => void;
	vi.mocked(api.request.getAutoHibernateSuggestion).mockReturnValue(new Promise(done => { resolve = done; }));
	render(<AutoHibernateSuggestions />);
	push(suggestion);
	push(null);
	await act(async () => { resolve(suggestion); });
	expect(screen.queryByRole("dialog")).toBeNull();
});


it("does not let a background client cancel another client's countdown", () => {
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
	render(<AutoHibernateSuggestions />);
	push({ ...suggestion, autoConfirmAt: Date.now() + 1000 });
	expect(api.request.respondAutoHibernateSuggestion).not.toHaveBeenCalled();
});
