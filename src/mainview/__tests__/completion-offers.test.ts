import { afterEach, describe, expect, it } from "vitest";
import { _resetCompletionOffersForTests, offerCompletion, pickCompletionOffer, registerCompletionStrip, useCompletionOffers } from "../completion-offers";
import { renderHook, act } from "@testing-library/react";

afterEach(() => _resetCompletionOffersForTests());

describe("completion offers", () => {
	it("resolves with the answer and removes the offer", async () => {
		const { result } = renderHook(() => useCompletionOffers());
		let answer!: Promise<unknown>;
		act(() => { answer = offerCompletion({ taskId: "t1", projectId: "p1", kind: "merge", branchName: "feat/x" }); });
		expect(result.current).toHaveLength(1);
		act(() => result.current[0]!.answer("manual"));
		await expect(answer).resolves.toBe("manual");
		expect(result.current).toHaveLength(0);
	});

	it("withdraws on abort and resolves false", async () => {
		const controller = new AbortController();
		const { result } = renderHook(() => useCompletionOffers());
		let answer!: Promise<unknown>;
		act(() => { answer = offerCompletion({ taskId: "t1", projectId: "p1", kind: "agent", signal: controller.signal }); });
		act(() => controller.abort());
		await expect(answer).resolves.toBe(false);
		expect(result.current).toHaveLength(0);
	});

	it("never registers an offer whose signal already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const { result } = renderHook(() => useCompletionOffers());
		await expect(offerCompletion({ taskId: "t1", projectId: "p1", kind: "agent", signal: controller.signal })).resolves.toBe(false);
		expect(result.current).toHaveLength(0);
	});

	it("answers once: a second answer is ignored", async () => {
		const { result } = renderHook(() => useCompletionOffers());
		let answer!: Promise<unknown>;
		act(() => { answer = offerCompletion({ taskId: "t1", projectId: "p1", kind: "merge" }); });
		const offer = result.current[0]!;
		act(() => { offer.answer(true); offer.answer(false); });
		await expect(answer).resolves.toBe(true);
	});

	it("joins a second offer of the same kind on a task instead of stacking it", async () => {
		const { result } = renderHook(() => useCompletionOffers());
		act(() => { void offerCompletion({ taskId: "t1", projectId: "p1", kind: "merge" }); });
		let second!: Promise<unknown>;
		act(() => { second = offerCompletion({ taskId: "t1", projectId: "p1", kind: "merge" }); });
		await expect(second).resolves.toBeNull();
		expect(result.current).toHaveLength(1);
	});

	it("shows the agent's request before a merge offer on the same task", () => {
		void offerCompletion({ taskId: "t1", projectId: "p1", kind: "merge" });
		void offerCompletion({ taskId: "t1", projectId: "p1", kind: "agent" });
		void offerCompletion({ taskId: "t2", projectId: "p1", kind: "merge" });
		const { result } = renderHook(() => useCompletionOffers());
		expect(pickCompletionOffer(result.current, "t1")?.kind).toBe("agent");
		expect(pickCompletionOffer(result.current, "t2")?.kind).toBe("merge");
		expect(pickCompletionOffer(result.current, "t3")).toBeNull();
	});

	it("shows the user's own ask first, and markers skip it", () => {
		void offerCompletion({ taskId: "t1", projectId: "p1", kind: "agent" });
		void offerCompletion({ taskId: "t1", projectId: "p1", kind: "user", status: "completed" });
		const { result } = renderHook(() => useCompletionOffers());
		expect(pickCompletionOffer(result.current, "t1")?.kind).toBe("user");
		expect(pickCompletionOffer(result.current, "t1", true)?.kind).toBe("agent");
	});

	it("withdraws the user's own ask when the last task view closes, and keeps unsolicited ones", async () => {
		const first = registerCompletionStrip("t1");
		const second = registerCompletionStrip("t1");
		const user = offerCompletion({ taskId: "t1", projectId: "p1", kind: "user", status: "cancelled" });
		void offerCompletion({ taskId: "t1", projectId: "p1", kind: "merge" });
		const { result } = renderHook(() => useCompletionOffers());
		act(() => first());
		expect(result.current).toHaveLength(2);
		act(() => second());
		await expect(user).resolves.toBe(false);
		expect(result.current.map((o) => o.kind)).toEqual(["merge"]);
	});
});
