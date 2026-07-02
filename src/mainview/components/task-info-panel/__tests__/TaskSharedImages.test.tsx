import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskSharedImages from "../TaskSharedImages";
import { I18nProvider } from "../../../i18n";
import type { Task, SharedImage } from "../../../../shared/types";

function sharedImage(id: string): SharedImage {
	return {
		id,
		storedPath: `/wt/shared-images/${id}.png`,
		originalPath: `/tmp/${id}.png`,
		name: `${id}.png`,
		mime: "image/png",
		bytes: 10,
		createdAt: 1,
	};
}

function makeTask(images?: SharedImage[]): Task {
	return { id: "task-1", sharedImages: images } as Task;
}

function renderBtn(task: Task) {
	return render(
		<I18nProvider>
			<TaskSharedImages task={task} />
		</I18nProvider>,
	);
}

describe("TaskSharedImages", () => {
	it("renders nothing when the task has no shared images", () => {
		const { container } = renderBtn(makeTask());
		expect(container).toBeEmptyDOMElement();
		expect(screen.queryByTestId("shared-images-badge")).not.toBeInTheDocument();
	});

	it("shows the image count when the task has shared images", () => {
		renderBtn(makeTask([sharedImage("a"), sharedImage("b"), sharedImage("c")]));
		const btn = screen.getByTestId("shared-images-badge");
		expect(btn).toHaveTextContent("3");
		expect(btn).toHaveAttribute("aria-label", expect.stringContaining("3"));
	});

	it("dispatches dev3:openImageViewer at the newest image when clicked", async () => {
		const task = makeTask([sharedImage("a"), sharedImage("b")]);
		const spy = vi.fn();
		window.addEventListener("dev3:openImageViewer", spy);
		renderBtn(task);
		await userEvent.click(screen.getByTestId("shared-images-badge"));
		window.removeEventListener("dev3:openImageViewer", spy);
		expect(spy).toHaveBeenCalledTimes(1);
		const detail = (spy.mock.calls[0][0] as CustomEvent).detail;
		expect(detail).toMatchObject({ taskId: "task-1", index: 1 });
		expect(detail.images).toHaveLength(2);
	});
});
