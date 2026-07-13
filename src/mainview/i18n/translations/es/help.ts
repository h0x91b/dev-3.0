const help = {
	// ── UI chrome ──
	"help.ui.aboutSection": "Acerca de esta sección",
	"help.ui.modeBanner": "Modo ayuda — haz clic en cualquier zona resaltada para saber qué hace",
	"help.ui.exitHint": "Esc para salir",
	"help.ui.whatYouCanDo": "Qué puedes hacer aquí",
	"help.ui.explainScreen": "Explicar esta pantalla…",
	"help.ui.openShortcuts": "Abrir atajos de teclado",

	// ── Board columns ──
	"help.board.column.todo.title": "Por hacer",
	"help.board.column.todo.body":
		"Tareas anotadas pero sin iniciar — sin worktree, sin agente, nada se ejecuta todavía. Al iniciar una tarea recibe un git worktree aislado y una terminal con el agente que elijas.",
	"help.board.column.inProgress.title": "En curso",
	"help.board.column.inProgress.body":
		"Un agente está trabajando activamente aquí. Cada tarea vive en su propio git worktree y terminal tmux — haz clic en la tarjeta para verlo en vivo. Las tarjetas avanzan solas cuando el agente termina o pregunta algo.",
	"help.board.column.userQuestions.title": "Preguntas para ti",
	"help.board.column.userQuestions.body":
		"El agente está bloqueado por ti: hizo una pregunta y espera. Abre la tarea, responde en la terminal y la tarjeta vuelve sola a En curso. Todo lo que esté aquí es un bloqueo — atiéndelo primero.",
	"help.board.column.reviewByAi.title": "Revisión por IA",
	"help.board.column.reviewByAi.body":
		"El trabajo está terminado y un segundo agente lo revisa automáticamente. No necesitas hacer nada — la tarjeta avanza sola cuando la revisión termina.",
	"help.board.column.reviewByUser.title": "Tu revisión",
	"help.board.column.reviewByUser.body":
		"El agente terminó y espera tu veredicto. Abre el diff desde el inspector de la tarea, revisa los cambios y completa la tarea — o devuélvela con comentarios.",
	"help.board.column.reviewByColleague.title": "Revisión de PR",
	"help.board.column.reviewByColleague.body":
		"La tarea espera la revisión del pull request por un colega. Sigue la insignia del PR en la tarjeta; completa la tarea cuando el PR se fusione.",
	"help.board.column.completed.title": "Completado",
	"help.board.column.completed.body":
		"Hecho y entregado. El worktree y la terminal de la tarea fueron destruidos; sus notas, resumen y registro de conversación sobreviven y siguen siendo buscables.",
	"help.board.column.cancelled.title": "Cancelado",
	"help.board.column.cancelled.body":
		"Tareas abandonadas. Igual que en Completado, el worktree desaparece — pero el registro (notas, resumen, historial) se conserva para el futuro.",

	// ── Board chrome ──
	"help.board.filterBar.title": "Búsqueda y filtros",
	"help.board.filterBar.body":
		"Una sola caja busca y filtra el tablero. Escribe texto libre para una búsqueda difusa por título/descripción, o filtra con tokens — priority:P0 label:\"Bug Fix\" agent:Codex status:review is:attention has:port. Los chips de prioridad P0–P4, los chips de etiquetas y el embudo editan estos mismos tokens, así que escribir y hacer clic nunca se contradicen. La × lo borra todo. Gestiona las etiquetas en Configuración del proyecto → Etiquetas.",
	"help.board.priorityFilter.title": "Filtro de prioridad",
	"help.board.priorityFilter.body":
		"Cada tarea tiene una prioridad P0 (la más alta) … P4 (la más baja, P3 por defecto). Las columnas siempre se ordenan por ella, así lo más importante queda arriba. Haz clic en un chip para mostrar solo esa prioridad; arrastra una tarjeta a otra banda para recategorizarla.",
	"help.filters.dsl.title": "Búsqueda y filtros",
	"help.filters.dsl.body":
		"Escribe para una búsqueda difusa por títulos y descripciones, o filtra con tokens: priority:P0 label:\"Bug Fix\" agent:Codex status:review is:attention has:port. Entrecomilla los valores con espacios. Combina facetas (Y); repite una faceta para ampliar (O). Los chips P0–P4, los chips de etiquetas y el embudo editan estos mismos tokens. Gestiona las etiquetas en Configuración del proyecto → Etiquetas.",
	"help.board.taskCard.title": "Tarjeta de tarea",
	"help.board.taskCard.body":
		"Los puntos de colores son variantes paralelas de agentes (cada una en su worktree), la campana significa que el agente te llama, y la insignia #123 es el PR de la tarea con su estado de CI y revisión. Clic derecho para todas las acciones.",

	// ── Dashboard ──
	"help.dashboard.projects.title": "Proyectos",
	"help.dashboard.projects.body":
		"Cada proyecto es un repositorio git con su propio tablero Kanban, etiquetas y scripts de ciclo de vida. Un tablero de Operaciones es un proyecto virtual: sus tareas ejecutan agentes en carpetas gestionadas, sin git.",
	"help.dashboard.statsEntry.title": "Estadísticas de productividad",
	"help.dashboard.statsEntry.body":
		"Tu Velocity Cockpit — gráficos de solo lectura de cuánto entregas: tareas, líneas, velocidad, rachas. Celebra el progreso; no configura nada.",
	"help.dashboard.projectRow.title": "Fila de proyecto",
	"help.dashboard.projectRow.body":
		"El número a la derecha son los agentes activos ahora. Las filas de colores debajo son tareas que te esperan — preguntas y revisiones. Haz clic en una para saltar directo a esa tarea.",

	// ── Task inspector ──
	"help.inspector.panel.title": "Inspector de tarea",
	"help.inspector.panel.body":
		"El centro de mando de la tarea activa, organizado en cuatro zonas: identidad de la tarea (arriba izquierda), agentes y terminal (arriba derecha), rama y PR (abajo izquierda), runtime y accesos (abajo derecha).",
	"help.inspector.contextBar.title": "Identidad de la tarea",
	"help.inspector.contextBar.body":
		"Quién es esta tarea: su estado, etiquetas y la insignia de diff — haz clic en ella para abrir la revisión completa. El interruptor de tests incluye o excluye archivos de test del conteo del diff.",
	"help.inspector.sessionBar.title": "Sesión y agentes",
	"help.inspector.sessionBar.body":
		"Controla quién trabaja en la tarea: añade un segundo agente a la misma sesión, suelta un enjambre de cazadores de bugs, y divide, amplía o reorganiza los paneles de tmux.",
	"help.inspector.gitBar.title": "Git y PR",
	"help.inspector.gitBar.body":
		"Todo lo relacionado con la rama: ver el diff, hacer rebase sobre la rama base, hacer push, abrir un pull request, fusionar. Las operaciones git corren en una terminal visible — siempre ves qué pasa.",
	"help.inspector.runtimeBar.title": "Runtime y accesos",
	"help.inspector.runtimeBar.body":
		"Lo que la tarea produce y cómo llegar a ello: abre el worktree en tu editor, ejecuta scripts del paquete, arranca o detén el servidor de desarrollo, inspecciona puertos e imágenes compartidas.",

	// ── Diff viewer ──
	"help.diff.modes.title": "Modos de diff",
	"help.diff.modes.body":
		"Uncommitted muestra lo que el agente aún no ha confirmado. Branch muestra toda la rama contra su base. Unpushed muestra los commits que no han salido hacia origin. Recent commits muestra solo el último commit; pulsa ▾ para ver los últimos 2, 3, 5 o 10, acotado a los commits propios de esta rama.",
	"help.diff.review.title": "Revisión inline",
	"help.diff.review.body":
		"Arrastra por el margen de líneas para comentar un rango. Copy review convierte todos los comentarios en un prompt para el agente — pégalo en la terminal de la tarea. La revisión sobrevive reinicios durante 3 días.",

	// ── Settings sections ──
	"help.settings.agents.title": "Agentes",
	"help.settings.agents.body":
		"Los agentes de código que lanzas y sus presets. Cada configuración es una receta de lanzamiento completa — modelo, modo, flags; cada tarea elige una al empezar. Arrastra para reordenar.",
	"help.settings.appearance.title": "Apariencia",
	"help.settings.appearance.body": "Tema, idioma, zoom y desplazamiento — cómo se ve y se siente la aplicación.",
	"help.settings.behavior.title": "Comportamiento",
	"help.settings.behavior.body":
		"Lo que ocurre alrededor de tus tareas automáticamente: revisión por IA cuando un agente termina, revisión por pares, consejos de funciones, notificaciones y modo concentración.",
	"help.settings.workspace.title": "Espacio de trabajo",
	"help.settings.workspace.body":
		"Dónde viven los worktrees de las tareas en disco, qué editores y aplicaciones externas alimentan open-in, y tus cuentas de GitHub.",
	"help.settings.devtools.title": "Herramientas de desarrollo",
	"help.settings.devtools.body": "Presets de teclado de la terminal y el estado de instalación del CLI dev3.",

	// ── Stats ──
	"help.stats.overview.title": "Velocity Cockpit",
	"help.stats.overview.body":
		"Prueba de solo lectura de tu velocidad de entrega. Los medidores y gráficos se recalculan con el selector de rango; navega periodos pasados con las flechas. El conteo de líneas empieza el día en que se lanzó el seguimiento — sin historial inventado.",

	// ── Modals ──
	"help.modal.createTask.title": "Crear una tarea",
	"help.modal.createTask.body":
		"La descripción se convierte en el prompt del agente. Save guarda la tarea en Por hacer; Run lanza un agente de inmediato; Scratch abre una terminal donde explicas el objetivo de forma interactiva.",
	"help.modal.launchVariants.title": "Variantes",
	"help.modal.launchVariants.body":
		"N variantes significa N agentes independientes resolviendo la misma tarea en paralelo, cada uno en su propio worktree y rama. Compara los resultados y quédate con el mejor — el resto se cancela.",

	// ── Header / sidebar ──
	"help.header.utilities.title": "Utilidades de la aplicación",
	"help.header.utilities.body":
		"Herramientas globales: la taza de café mantiene despierta tu máquina mientras los agentes trabajan, el icono de terminal gestiona sesiones tmux, y la insignia de commits trae cambios frescos de la rama principal.",
	"help.sidebar.activeTasks.title": "Tareas activas",
	"help.sidebar.activeTasks.body":
		"Todas las tareas con un agente vivo, en todos los proyectos. Haz clic para saltar; pasa el cursor para una vista previa en vivo de la terminal.",
} as const;

export default help;
