import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SharedArtifact, SharedImage, Task } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import SharedOutputsList from "../SharedOutputsList";

function image(id: string, caption?: string): SharedImage {
	return {
		id,
		storedPath: `/wt/shared-images/${id}.png`,
		originalPath: `/tmp/${id}.png`,
		name: `${id}.png`,
		mime: "image/png",
		bytes: 10,
		caption,
		createdAt: 1_780_000_000_000,
	};
}

function artifact(id: string): SharedArtifact {
	return {
		id,
		kind: "html",
		title: `Report ${id}`,
		name: `${id}.html`,
		storedPath: `/wt/shared-artifacts/${id}/${id}.html`,
		originalPath: `/tmp/${id}.html`,
		bytes: 10,
		createdAt: 1_780_000_000_000,
		assets: [],
	};
}

function renderList(task: Partial<Task>) {
	return render(
		<I18nProvider>
			<SharedOutputsList task={{ id: "task-1", ...task } as Task} projectId="project-1" />
		</I18nProvider>,
	);
}

describe("SharedOutputsList", () => {
	it("renders nothing when the task shared neither images nor artifacts", () => {
		const { container } = renderList({});
		expect(container).toBeEmptyDOMElement();
	});

	it("enumerates every image with its caption and every artifact with its title", () => {
		renderList({
			sharedImages: [image("before", "current bug"), image("after")],
			sharedArtifacts: [artifact("a")],
		});
		const imageRows = screen.getAllByTestId("shared-image-link");
		expect(imageRows).toHaveLength(2);
		expect(imageRows[0]).toHaveTextContent("before.png");
		expect(imageRows[0]).toHaveTextContent("current bug");
		expect(screen.getAllByTestId("shared-artifact-link")).toHaveLength(1);
		expect(screen.getByTestId("shared-artifact-link")).toHaveTextContent("Report a");
	});

	it("opens the image viewer at the clicked row, not at the newest image", async () => {
		const spy = vi.fn();
		window.addEventListener("dev3:openImageViewer", spy);
		renderList({ sharedImages: [image("first"), image("second"), image("third")] });
		await userEvent.click(screen.getAllByTestId("shared-image-link")[0]);
		window.removeEventListener("dev3:openImageViewer", spy);
		const detail = (spy.mock.calls[0][0] as CustomEvent).detail;
		expect(detail).toMatchObject({ taskId: "task-1", projectId: "project-1", index: 0 });
		expect(detail.images).toHaveLength(3);
	});

	it("asks for a standalone artifact overlay — the archived modal has no workspace pane", async () => {
		const spy = vi.fn();
		window.addEventListener("dev3:openArtifactViewer", spy);
		renderList({ sharedArtifacts: [artifact("a"), artifact("b")] });
		await userEvent.click(screen.getAllByTestId("shared-artifact-link")[1]);
		window.removeEventListener("dev3:openArtifactViewer", spy);
		expect((spy.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ index: 1, standalone: true });
	});

	it("leads with artifacts — the deliverable outranks the screenshots", () => {
		renderList({ sharedImages: [image("shot")], sharedArtifacts: [artifact("a")] });
		const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
		expect(headings).toEqual([expect.stringContaining("Artifacts"), expect.stringContaining("Images")]);
	});

	it("names each section so the block is reachable by heading, not only by eye", () => {
		renderList({ sharedImages: [image("shot")], sharedArtifacts: [artifact("a")] });
		expect(screen.getByRole("region", { name: /Artifacts/ })).toBeTruthy();
		expect(screen.getByRole("region", { name: /Images/ })).toBeTruthy();
	});

	it("describes an artifact by size and assets, never by its always-identical filename", () => {
		renderList({ sharedArtifacts: [{ ...artifact("a"), bytes: 2048, assets: [{ name: "app.css", storedPath: "/s", originalPath: "/o", mime: "text/css", bytes: 1 }] }] });
		const row = screen.getByTestId("shared-artifact-link");
		expect(row).toHaveTextContent("2 KB · 1 asset");
		expect(row).not.toHaveTextContent("a.html");
	});
});
