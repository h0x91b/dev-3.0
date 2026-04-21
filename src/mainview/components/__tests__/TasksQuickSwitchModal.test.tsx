import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { I18nProvider } from "../../i18n";
import TasksQuickSwitchModal from "../TasksQuickSwitchModal";

describe("TasksQuickSwitchModal", () => {
	it("renders into document.body so ancestor layout cannot clip it", () => {
		const host = document.createElement("div");
		host.style.transform = "translateZ(0)";
		document.body.appendChild(host);

		try {
			render(
				<I18nProvider>
					<TasksQuickSwitchModal
						items={[
							{
								projectId: "p1",
								projectName: "Alpha",
								taskId: "t1",
								taskTitle: "Current Task",
								status: "in-progress",
							},
						]}
						selectedIndex={0}
						shortcut={{ modifiers: ["ctrl"], key: "Tab" }}
					/>
				</I18nProvider>,
				{ container: host },
			);

			expect(host.querySelector('[role="dialog"]')).toBeNull();
			expect(document.body.querySelector('[role="dialog"]')).toBeTruthy();
		} finally {
			host.remove();
		}
	});

	it("marks the selected row and renders custom-column labels", () => {
		render(
			<I18nProvider>
				<TasksQuickSwitchModal
					items={[
						{
							projectId: "p1",
							projectName: "Alpha",
							taskId: "t1",
							taskTitle: "Current Task",
							status: "in-progress",
						},
						{
							projectId: "p1",
							projectName: "Alpha",
							taskId: "t2",
							taskTitle: "Waiting Task",
							status: "in-progress",
							customColumnName: "Waiting on API",
							customColumnColor: "#22c55e",
						},
					]}
					selectedIndex={0}
					shortcut={{ modifiers: ["ctrl"], key: "Tab" }}
				/>
			</I18nProvider>,
		);

		const options = screen.getAllByRole("option");
		expect(options).toHaveLength(2);
		expect(options[0]).toHaveAttribute("aria-selected", "true");
		expect(options[1]).toHaveAttribute("aria-selected", "false");
		expect(screen.getByText("Waiting on API")).toBeInTheDocument();
	});

	it("scrolls the selected option into view when the selection changes", () => {
		const scrollSpy = vi
			.spyOn(HTMLElement.prototype, "scrollIntoView")
			.mockImplementation(() => {});

		try {
			const items = Array.from({ length: 8 }, (_, index) => ({
				projectId: "p1",
				projectName: "Alpha",
				taskId: `t${index + 1}`,
				taskTitle: `Task ${index + 1}`,
				status: "in-progress" as const,
			}));

			const { rerender } = render(
				<I18nProvider>
					<TasksQuickSwitchModal
						items={items}
						selectedIndex={0}
						shortcut={{ modifiers: ["ctrl"], key: "Tab" }}
					/>
				</I18nProvider>,
			);

			scrollSpy.mockClear();

			rerender(
				<I18nProvider>
					<TasksQuickSwitchModal
						items={items}
						selectedIndex={7}
						shortcut={{ modifiers: ["ctrl"], key: "Tab" }}
					/>
				</I18nProvider>,
			);

			expect(scrollSpy).toHaveBeenLastCalledWith({ block: "nearest" });
		} finally {
			scrollSpy.mockRestore();
		}
	});
});
