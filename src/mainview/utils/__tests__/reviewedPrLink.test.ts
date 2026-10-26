import { reviewedPrLink } from "../taskPrBadge";

describe("reviewedPrLink", () => {
	const reviewedPr = { number: 2067, url: "https://github.com/h0x91b/dev-3.0/pull/2067" };

	it("links the stored reviewed PR", () => {
		expect(reviewedPrLink({ reviewedPr }, null)).toEqual(reviewedPr);
	});

	it("yields to the task's own badge for the same PR, never for a different one", () => {
		expect(reviewedPrLink({ reviewedPr }, { number: 2067, url: reviewedPr.url })).toBeNull();
		expect(reviewedPrLink({ reviewedPr }, { number: 9, url: "u" })).toEqual(reviewedPr);
	});

	it("is null with no association or nothing to open", () => {
		expect(reviewedPrLink({}, null)).toBeNull();
		expect(reviewedPrLink({ reviewedPr: null }, null)).toBeNull();
		expect(reviewedPrLink({ reviewedPr: { number: 1, url: "" } }, null)).toBeNull();
	});
});
