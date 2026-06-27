import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import ProjectQuickSwitchModal from "../ProjectQuickSwitchModal";
import type { Project } from "../../../shared/types";

function project(id: string, name: string): Project {
	return {
		id,
		name,
		path: `/tmp/${id}`,
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "",
	};
}

const PROJECTS: Project[] = [
	project("p1", "users-service"),
	project("p2", "auth-gateway"),
	project("p3", "billing"),
];

function renderModal(handlers: { onSelect?: (id: string) => void; onClose?: () => void } = {}) {
	const onSelect = handlers.onSelect ?? vi.fn();
	const onClose = handlers.onClose ?? vi.fn();
	render(
		<I18nProvider>
			<ProjectQuickSwitchModal projects={PROJECTS} onSelect={onSelect} onClose={onClose} />
		</I18nProvider>,
	);
	return { onSelect, onClose };
}

beforeEach(() => {
	document.body.innerHTML = "";
});

describe("ProjectQuickSwitchModal", () => {
	it("traps focus inside the dialog on open", () => {
		renderModal();
		const dialog = screen.getByRole("dialog");
		expect(dialog.contains(document.activeElement)).toBe(true);
	});

	it("lists all projects initially", () => {
		renderModal();
		expect(screen.getByText("users-service")).toBeTruthy();
		expect(screen.getByText("auth-gateway")).toBeTruthy();
		expect(screen.getByText("billing")).toBeTruthy();
	});

	it("filters projects as the user types", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.type(screen.getByRole("textbox"), "auth");
		const options = screen.getAllByRole("option");
		expect(options).toHaveLength(1);
		expect(options[0].textContent).toContain("auth-gateway");
	});

	it("navigates to the top match on Enter", async () => {
		const user = userEvent.setup();
		const { onSelect } = renderModal();
		await user.type(screen.getByRole("textbox"), "users");
		await user.keyboard("{Enter}");
		expect(onSelect).toHaveBeenCalledWith("p1");
	});

	it("moves the selection with arrow keys", async () => {
		const user = userEvent.setup();
		const { onSelect } = renderModal();
		// No query → all three in order; ArrowDown picks the second one.
		await user.keyboard("{ArrowDown}");
		await user.keyboard("{Enter}");
		expect(onSelect).toHaveBeenCalledWith("p2");
	});

	it("shows an empty state when nothing matches", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.type(screen.getByRole("textbox"), "zzzzz");
		expect(screen.queryAllByRole("option")).toHaveLength(0);
		expect(screen.getByText("No matching projects")).toBeTruthy();
	});

	it("closes on Escape", async () => {
		const user = userEvent.setup();
		const { onClose } = renderModal();
		await user.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalled();
	});

	it("selects a project on click", async () => {
		const user = userEvent.setup();
		const { onSelect } = renderModal();
		await user.click(screen.getByText("billing"));
		expect(onSelect).toHaveBeenCalledWith("p3");
	});

	it("renders the ⌘N badge from the board index, not the display row", async () => {
		// p3 (billing) sits at board index 2 but is shown first (recency); its
		// badge must read ⌘3, following the board-order Cmd+1..9 shortcut.
		render(
			<I18nProvider>
				<ProjectQuickSwitchModal
					projects={[PROJECTS[2], PROJECTS[0], PROJECTS[1]]}
					shortcutIndexById={{ p1: 0, p2: 1, p3: 2 }}
					onSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			</I18nProvider>,
		);
		const options = screen.getAllByRole("option");
		expect(options[0].textContent).toContain("billing");
		expect(options[0].textContent).toContain("⌘3");
		expect(options[1].textContent).toContain("⌘1");
	});

	it("renders the builtin Operations board with its bracketed name and ⌘0 badge", () => {
		const ops: Project = { ...project("vp1", "Operations"), kind: "virtual", builtin: true };
		render(
			<I18nProvider>
				<ProjectQuickSwitchModal
					projects={[ops, PROJECTS[0]]}
					shortcutIndexById={{ p1: 0 }}
					onSelect={vi.fn()}
					onClose={vi.fn()}
				/>
			</I18nProvider>,
		);
		const options = screen.getAllByRole("option");
		// Builtin board shows its special bracketed name and the ⌘0 badge (not ⌘1).
		expect(options[0].textContent).toContain("[ Operations ]");
		expect(options[0].textContent).toContain("⌘0");
		// Ordinary project keeps its board-index badge.
		expect(options[1].textContent).toContain("⌘1");
	});
});
