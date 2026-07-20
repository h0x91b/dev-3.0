import { describe, expect, it } from "vitest";
import type { Label, Project, Task, TaskDialogSubject } from "../../../shared/types";
import { taskDialogInfo, taskDialogInfoFromSubject } from "../taskDialogInfo";

const LABEL: Label = { id: "l1", name: "Feature", color: "#84cc16" };

const subject: TaskDialogSubject = {
	seqLabel: "1159-1",
	projectName: "dev-3.0",
	priority: "P0",
	labels: [LABEL],
	overview: "Almost done.",
};

describe("taskDialogInfoFromSubject", () => {
	it("maps a wire subject into the confirm info card, overview → body", () => {
		expect(taskDialogInfoFromSubject("Ship it", subject)).toEqual({
			title: "Ship it",
			body: "Almost done.",
			seqLabel: "1159-1",
			projectName: "dev-3.0",
			priority: "P0",
			labels: [LABEL],
		});
	});

	it("coerces a null overview to an undefined body", () => {
		const info = taskDialogInfoFromSubject("T", { ...subject, overview: null });
		expect(info.body).toBeUndefined();
	});

	it("falls back to a title-only card when the subject is absent", () => {
		expect(taskDialogInfoFromSubject("Only a title")).toEqual({ title: "Only a title" });
	});
});

describe("taskDialogInfo", () => {
	it("resolves the info card from a live task + project", () => {
		const task = {
			seq: 42,
			variantIndex: null,
			customTitle: "Do the thing",
			priority: "P1",
			labelIds: ["l1"],
			overview: "agent overview",
		} as Task;
		const project = { name: "dev-3.0", labels: [LABEL] } as Project;

		expect(taskDialogInfo(task, project)).toEqual({
			title: "Do the thing",
			body: "agent overview",
			seqLabel: "42",
			projectName: "dev-3.0",
			priority: "P1",
			labels: [LABEL],
		});
	});
});
