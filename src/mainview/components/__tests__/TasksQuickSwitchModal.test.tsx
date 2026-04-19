import { render, screen } from "@testing-library/react";
import TasksQuickSwitchModal from "../TasksQuickSwitchModal";
import { I18nProvider } from "../../i18n";
import { vi } from "vitest";

describe("TasksQuickSwitchModal", () => {
	it("renders outside the app container so viewport positioning is not affected by ancestor layout", () => {
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

			expect(screen.getByText("Tasks Quick Switch")).toBeInTheDocument();
			expect(host.querySelector('[role="dialog"]')).toBeNull();
			expect(document.body.querySelector('[role="dialog"]')).toBeTruthy();
		} finally {
			host.remove();
		}
	});

	it("uses a stronger accent background for the selected task while keeping non-selected rows neutral", () => {
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
							taskTitle: "Other Task",
							status: "todo",
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
		expect(options[0]).toHaveClass("bg-accent/20", "border-accent/40");
		expect(options[1]).toHaveAttribute("aria-selected", "false");
		expect(options[1]).toHaveClass("border-transparent");
		expect(options[1]).not.toHaveClass("bg-accent/20");
	});

	it("keeps the dialog height bounded and scrolls the list internally once there are more than six items", () => {
		render(
			<I18nProvider>
				<TasksQuickSwitchModal
					items={Array.from({ length: 8 }, (_, index) => ({
						projectId: "p1",
						projectName: "Alpha",
						taskId: `t${index + 1}`,
						taskTitle: `Task ${index + 1}`,
						status: "in-progress" as const,
					}))}
					selectedIndex={0}
					shortcut={{ modifiers: ["ctrl"], key: "Tab" }}
				/>
			</I18nProvider>,
		);

		const dialog = screen.getByRole("dialog", { name: "Tasks Quick Switch" });
		const listbox = screen.getByRole("listbox", { name: "Tasks Quick Switch" });

		expect(dialog).toHaveClass("max-h-[calc(100vh-2rem)]", "flex", "flex-col");
		expect(listbox).toHaveClass("max-h-[26rem]", "overflow-y-auto");
		expect(screen.getAllByRole("option")).toHaveLength(8);
	});

	it("scrolls the selected option into view when the selection moves forward or backward", () => {
		const scrollSpy = vi
			.spyOn(HTMLElement.prototype, "scrollIntoView")
			.mockImplementation(() => {});

		try {
			const { rerender } = render(
				<I18nProvider>
					<TasksQuickSwitchModal
						items={Array.from({ length: 8 }, (_, index) => ({
							projectId: "p1",
							projectName: "Alpha",
							taskId: `t${index + 1}`,
							taskTitle: `Task ${index + 1}`,
							status: "in-progress" as const,
						}))}
						selectedIndex={0}
						shortcut={{ modifiers: ["ctrl"], key: "Tab" }}
					/>
				</I18nProvider>,
			);

			scrollSpy.mockClear();

			rerender(
				<I18nProvider>
					<TasksQuickSwitchModal
						items={Array.from({ length: 8 }, (_, index) => ({
							projectId: "p1",
							projectName: "Alpha",
							taskId: `t${index + 1}`,
							taskTitle: `Task ${index + 1}`,
							status: "in-progress" as const,
						}))}
						selectedIndex={7}
						shortcut={{ modifiers: ["ctrl"], key: "Tab" }}
					/>
				</I18nProvider>,
			);

			expect(scrollSpy).toHaveBeenLastCalledWith({
				block: "nearest",
			});

			scrollSpy.mockClear();

			rerender(
				<I18nProvider>
					<TasksQuickSwitchModal
						items={Array.from({ length: 8 }, (_, index) => ({
							projectId: "p1",
							projectName: "Alpha",
							taskId: `t${index + 1}`,
							taskTitle: `Task ${index + 1}`,
							status: "in-progress" as const,
						}))}
						selectedIndex={1}
						shortcut={{ modifiers: ["ctrl"], key: "Tab" }}
					/>
				</I18nProvider>,
			);

			expect(scrollSpy).toHaveBeenLastCalledWith({
				block: "nearest",
			});
		} finally {
			scrollSpy.mockRestore();
		}
	});
});
