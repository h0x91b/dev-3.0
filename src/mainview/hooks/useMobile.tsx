import { createContext, useContext, useMemo, type ReactNode } from "react";

/**
 * Detect whether the device is mobile based on physical screen width.
 * We use screen.width (not window.innerWidth) because the viewport meta tag
 * may override the layout width. screen.width reflects the real device.
 *
 * Threshold: 1024px — tablets in landscape are treated as desktop.
 */
const MOBILE_BREAKPOINT = 1024;

function detectMobile(): boolean {
	if (typeof window === "undefined") return false;
	return screen.width < MOBILE_BREAKPOINT;
}

const MobileContext = createContext<boolean>(false);

export function MobileProvider({ children }: { children: ReactNode }) {
	const isMobile = useMemo(detectMobile, []);
	return (
		<MobileContext.Provider value={isMobile}>
			{children}
		</MobileContext.Provider>
	);
}

export function useMobile(): boolean {
	return useContext(MobileContext);
}
