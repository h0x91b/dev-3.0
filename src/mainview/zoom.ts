/** Type for the zoom API exposed by main.tsx on window.__dev3Zoom */
export interface Dev3ZoomApi {
	applyZoom: (level: number) => void;
	getZoom: () => number;
	adjustZoom: (delta: number) => void;
	ZOOM_STEP: number;
	DEFAULT_ZOOM: number;
	MIN_ZOOM: number;
	MAX_ZOOM: number;
}

/** Get the zoom API set up by main.tsx during bootstrap */
export function getZoomApi(): Dev3ZoomApi {
	return (window as any).__dev3Zoom;
}
