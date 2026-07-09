import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SharedArtifact, Task } from "../../../../shared/types";
import { I18nProvider } from "../../../i18n";
import TaskArtifacts from "../TaskArtifacts";

function artifact(id: string): SharedArtifact {
	return {
		id,
		kind: "html",
		title: id,
		name: `${id}.html`,
		storedPath: `/wt/shared-artifacts/${id}/${id}.html`,
		originalPath: `/tmp/${id}.html`,
		bytes: 10,
		createdAt: 1,
		assets: [],
	};
}

function renderButton(artifacts?: SharedArtifact[]) {
	return render(<I18nProvider><TaskArtifacts task={{ id: "task-1", sharedArtifacts: artifacts } as Task} /></I18nProvider>);
}

describe("TaskArtifacts", () => {
	it("renders separately from Images only when artifacts exist", () => {
		const { container } = renderButton();
		expect(container).toBeEmptyDOMElement();
		renderButton([artifact("a"), artifact("b")]);
		expect(screen.getByTestId("shared-artifacts-badge")).toHaveTextContent("Artifacts2");
	});

	it("opens the latest artifact", async () => {
		const spy = vi.fn();
		window.addEventListener("dev3:openArtifactViewer", spy);
		renderButton([artifact("a"), artifact("b")]);
		await userEvent.click(screen.getByTestId("shared-artifacts-badge"));
		window.removeEventListener("dev3:openArtifactViewer", spy);
		const detail = (spy.mock.calls[0][0] as CustomEvent).detail;
		expect(detail).toMatchObject({ taskId: "task-1", index: 1 });
		expect(detail.artifacts).toHaveLength(2);
	});
});
