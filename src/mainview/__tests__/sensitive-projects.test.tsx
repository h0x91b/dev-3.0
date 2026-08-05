import { describe, expect, it, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { Project } from "../../shared/types";
import { setStreamerMode } from "../streamer-mode";
import {
	MASK_CLASS,
	getSensitiveProjectIds,
	isProjectSensitive,
	setSensitiveProjectIds,
	useProjectPrivacy,
} from "../sensitive-projects";

function makeProject(overrides?: Partial<Project>): Project {
	return { id: "p1", name: "Secret", path: "/tmp/secret", ...overrides } as Project;
}

function Probe({ project }: { project: Project | string }) {
	const privacy = useProjectPrivacy();
	return (
		<span data-testid="probe" className={privacy.maskClass(project)}>
			{privacy.isLocked(project) ? "locked" : "open"}
		</span>
	);
}

beforeEach(() => {
	localStorage.clear();
	delete document.documentElement.dataset.streamer;
	setStreamerMode(false);
	setSensitiveProjectIds([]);
});

describe("the sensitive flag is inert until streamer mode is on", () => {
	it("does not lock a sensitive project while streamer mode is off", () => {
		render(<Probe project={makeProject({ sensitive: true })} />);
		expect(screen.getByTestId("probe").textContent).toBe("open");
		expect(screen.getByTestId("probe").className).toBe("");
	});

	it("locks and masks it once streamer mode goes on", () => {
		render(<Probe project={makeProject({ sensitive: true })} />);
		act(() => setStreamerMode(true));
		expect(screen.getByTestId("probe").textContent).toBe("locked");
		expect(screen.getByTestId("probe").className).toContain(MASK_CLASS);
	});

	it("leaves a project without the flag alone in streamer mode", () => {
		render(<Probe project={makeProject()} />);
		act(() => setStreamerMode(true));
		expect(screen.getByTestId("probe").textContent).toBe("open");
	});
});

describe("verdict by project id", () => {
	it("resolves an id through the published set", () => {
		render(<Probe project="p1" />);
		act(() => setStreamerMode(true));
		expect(screen.getByTestId("probe").textContent).toBe("open");

		act(() => setSensitiveProjectIds(["p1"]));
		expect(screen.getByTestId("probe").textContent).toBe("locked");
	});

	it("re-renders when the flag is cleared", () => {
		setSensitiveProjectIds(["p1"]);
		render(<Probe project="p1" />);
		act(() => setStreamerMode(true));
		expect(screen.getByTestId("probe").textContent).toBe("locked");

		act(() => setSensitiveProjectIds([]));
		expect(screen.getByTestId("probe").textContent).toBe("open");
	});
});

describe("the published set", () => {
	it("keeps the last publication", () => {
		setSensitiveProjectIds(["a", "b"]);
		expect([...getSensitiveProjectIds()].sort()).toEqual(["a", "b"]);
	});

	it("reads the flag off a project object", () => {
		expect(isProjectSensitive(makeProject({ sensitive: true }))).toBe(true);
		expect(isProjectSensitive(makeProject())).toBe(false);
		expect(isProjectSensitive(null)).toBe(false);
	});
});
