import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import ScrollToLatestButton from "../ScrollToLatestButton";
import { I18nProvider } from "../../i18n";

afterEach(cleanup);

describe("ScrollToLatestButton", () => {
	it("is a labelled 48px round button that fires onClick", () => {
		const onClick = vi.fn();
		render(<I18nProvider><ScrollToLatestButton onClick={onClick} /></I18nProvider>);
		const btn = screen.getByTestId("scroll-to-latest");
		expect(btn).toHaveAttribute("aria-label", "Back to latest output");
		expect(btn.className).toContain("w-12");
		expect(btn.className).toContain("h-12");
		expect(btn.className).toContain("rounded-full");
		fireEvent.click(btn);
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it("keeps the current focus on press (mousedown is prevented, like the key bar)", () => {
		render(<I18nProvider><ScrollToLatestButton onClick={() => {}} /></I18nProvider>);
		const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
		screen.getByTestId("scroll-to-latest").dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
	});
});
