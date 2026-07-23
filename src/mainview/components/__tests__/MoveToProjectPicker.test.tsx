import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import MoveToProjectPicker from "../MoveToProjectPicker";
import { I18nProvider } from "../../i18n";
import type { Project } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: { request: { getProjects: vi.fn() } },
}));

import { api } from "../../rpc";

const mockedApi = vi.mocked(api, true);

function makeProject(overrides: Partial<Project> & { id: string; name: string }): Project {
	return {
		path: `/tmp/${overrides.id}`,
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "2025-01-01T00:00:00Z",
		...overrides,
	};
}

const current = makeProject({ id: "current", name: "Current Project" });
const alpha = makeProject({ id: "alpha", name: "Alpha" });
const beta = makeProject({ id: "beta", name: "Beta" });
const goneProject = makeProject({ id: "gone", name: "Deleted Project", deleted: true });

function renderPicker(props: Partial<React.ComponentProps<typeof MoveToProjectPicker>> = {}) {
	const anchor = document.createElement("button");
	document.body.appendChild(anchor);
	const onSelect = props.onSelect ?? vi.fn();
	const onClose = props.onClose ?? vi.fn();
	render(
		<I18nProvider>
			<MoveToProjectPicker currentProjectId="current" anchorEl={anchor} onSelect={onSelect} onClose={onClose} {...props} />
		</I18nProvider>,
	);
	return { onSelect, onClose };
}

describe("MoveToProjectPicker", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getProjects.mockResolvedValue([current, alpha, beta, goneProject]);
	});

	it("lists only valid destinations — the current project and deleted projects are excluded", async () => {
		renderPicker();
		expect(await screen.findByText("Alpha")).toBeInTheDocument();
		expect(screen.getByText("Beta")).toBeInTheDocument();
		expect(screen.queryByText("Current Project")).not.toBeInTheDocument();
		expect(screen.queryByText("Deleted Project")).not.toBeInTheDocument();
	});

	it("calls onSelect with the chosen destination", async () => {
		const { onSelect } = renderPicker();
		const option = await screen.findByText("Beta");
		await userEvent.click(option);
		expect(onSelect).toHaveBeenCalledWith(beta);
	});

	it("filters the destination list by the search query", async () => {
		renderPicker();
		await screen.findByText("Alpha");
		const search = screen.getByRole("textbox");
		await userEvent.type(search, "bet");
		expect(screen.getByText("Beta")).toBeInTheDocument();
		expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
	});

	it("shows an empty state when there is no other project to move to", async () => {
		mockedApi.request.getProjects.mockResolvedValue([current]);
		renderPicker();
		expect(await screen.findByText("No other projects available")).toBeInTheDocument();
	});

	describe("mobile", () => {
		const originalMatchMedia = window.matchMedia;
		beforeEach(() => {
			Object.defineProperty(window, "matchMedia", {
				configurable: true,
				writable: true,
				value: (query: string) => ({
					matches: query.includes("max-width"),
					media: query,
					onchange: null,
					addEventListener: () => {},
					removeEventListener: () => {},
					addListener: () => {},
					removeListener: () => {},
					dispatchEvent: () => false,
				}),
			});
		});
		afterEach(() => {
			Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: originalMatchMedia });
		});

		it("renders the picker as a BottomSheet on a narrow viewport", async () => {
			renderPicker();
			expect(await screen.findByTestId("move-to-project-sheet")).toBeInTheDocument();
			expect(screen.queryByTestId("move-to-project-popover")).not.toBeInTheDocument();
			expect(await screen.findByText("Alpha")).toBeInTheDocument();
		});
	});
});
