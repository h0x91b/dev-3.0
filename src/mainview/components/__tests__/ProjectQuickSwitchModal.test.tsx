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
});
