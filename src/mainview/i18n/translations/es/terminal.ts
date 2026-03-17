const terminal = {
	// TaskTerminal
	"terminal.connecting": "Conectando...",
	"terminal.envError": "Error del entorno de la tarea",
	"terminal.worktreeNotFound": "El directorio de trabajo de la tarea ya no existe. Esto puede ocurrir cuando el worktree se elimina externamente.",
	"terminal.errorPath": "Worktree no encontrado:",
	"terminal.complete": "Completar",
	"terminal.cancelTask": "Cancelar tarea",
	"terminal.sessionEnded": "Sesión de terminal finalizada",
	"terminal.sessionEndedDesc": "El proceso del terminal ha finalizado. El worktree y todos los archivos están intactos.",
	"terminal.resumeAgentSession": "Reanudar sesión",

	// Tmux hotkey hints
	"tmux.hSplit": "h-div",
	"tmux.vSplit": "v-div",
	"tmux.zoom": "zoom",
	"tmux.title": "Atajos de tmux",
	"tmux.panes": "Paneles",
	"tmux.splitHDesc": "Dividir horizontalmente",
	"tmux.splitVDesc": "Dividir verticalmente",
	"tmux.zoomDesc": "Zoom del panel (alternar)",
	"tmux.closePaneDesc": "Cerrar panel",
	"tmux.selectPaneDesc": "Haz clic en un panel para seleccionarlo",
	"tmux.resizePaneDesc": "Arrastra el borde del panel para redimensionar",
	"tmux.keyboardMode": "Modo de teclado",

	// Tmux Session Manager
	"tmuxSessions.title": "Sesiones tmux",
	"tmuxSessions.empty": "No hay sesiones dev3 activas",
	"tmuxSessions.sessionCount_one": "{count} sesión",
	"tmuxSessions.sessionCount_other": "{count} sesiones",
	"tmuxSessions.copied": "¡Copiado!",
	"tmuxSessions.kill": "Terminar",
	"tmuxSessions.killConfirmTitle": "Terminar sesión tmux",
	"tmuxSessions.killConfirmMessage": "¿Terminar sesión \"{name}\"? Esto cerrará todos los procesos.",
	"tmuxSessions.killFailed": "Error al terminar sesión: {error}",
	"tmuxSessions.cleanup": "limpieza",
	"tmuxSessions.killAll": "Terminar todas",
	"tmuxSessions.killAllConfirmTitle": "Terminar todas las sesiones tmux",
	"tmuxSessions.killAllConfirmMessage": "¿Terminar las {count} sesiones dev3? Esto cerrará todos los procesos.",
	"tmuxSessions.refresh": "Actualizar",

	// Spawn Agent
	"tmux.spawnExtraAgent": "Agente extra",
	"tmux.spawnExtraAgentDesc": "Lanzar otro agente en un nuevo panel",

	// Ports
	"ports.title": "Puertos",
	"ports.empty": "Sin puertos abiertos",
	"ports.openInBrowser": "Abrir en navegador",
	"ports.copyUrl": "Copiar URL",
	"ports.copied": "¡Copiado!",
	"ports.count_one": "{count} puerto",
	"ports.count_other": "{count} puertos",

	// Project Terminal
	"projectTerminal.open": "Terminal del proyecto",
	"projectTerminal.close": "Cerrar terminal",
	"projectTerminal.tooltip": "Abrir terminal en la raíz del proyecto",
	"projectTerminal.sessionEnded": "Sesión de terminal finalizada",
	"projectTerminal.sessionEndedDesc": "El proceso del terminal ha terminado. Haz clic en reiniciar para abrir una nueva sesión.",
	"projectTerminal.restart": "Reiniciar",
	"projectTerminal.label": "Terminal del proyecto",
};

export default terminal;
