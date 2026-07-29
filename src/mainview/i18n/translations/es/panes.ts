import type { TranslationRecord } from "../en";

const panes: Pick<TranslationRecord, `panes.${string}` & keyof TranslationRecord> & Record<string, string> = {
	"panes.layoutLabel": "Diseño",
	"panes.layoutNeedsTwoPanes": "Se necesitan al menos 2 paneles para cambiar el diseño",
	"panes.nativeHintsTitle": "Atajos de terminal",
	"panes.nativeNoPrefixKeys": "Sin prefijo ⌃B — las acciones de panel usan la barra de herramientas",
	"panes.nativeWindowsUnavailable": "Las ventanas son exclusivas de tmux (no disponibles en tareas nativas)",
	"panes.paneLabel": "Panel {index}",
	"panes.exited": "Panel finalizado",
	"panes.exitedClose": "Cerrar panel",
	"panes.hostGone": "El host del terminal no está disponible — use los controles de recuperación",
	"panes.unsupportedOnBackend": "No compatible con este backend",
} as unknown as Pick<TranslationRecord, `panes.${string}` & keyof TranslationRecord> & Record<string, string>;

export default panes;
