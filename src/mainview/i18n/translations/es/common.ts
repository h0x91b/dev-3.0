const common = {
	// App
	"app.loading": "Cargando...",
	"app.branchMergedTitle": "Rama fusionada",
	"app.branchMergedMessage": "Todos los cambios de \"{branchName}\" están en la rama base.\n\nTarea: {taskTitle}\n\n¿Marcar esta tarea como completada?",

	// Quit dialog
	"quit.dialogTitle": "Las sesiones siguen activas",
	"quit.dialogMessage": "Tus sesiones de terminal seguirán ejecutándose en tmux después de salir. Podrás reconectarte al volver a abrir la aplicación.",
	"quit.dontShowAgain": "No mostrar de nuevo",
	"quit.confirm": "Salir",
	"quit.cancel": "Cancelar",

	// Status labels
	"status.todo": "Por hacer",
	"status.inProgress": "Agente trabajando",
	"status.userQuestions": "Tiene preguntas",
	"status.reviewByAi": "Revisión IA",
	"status.reviewByUser": "Tu revisión",
	"status.reviewByColleague": "Revisión PR",
	"status.completed": "Completado",
	"status.cancelled": "Cancelado",

	// Status descriptions (info tooltips for column headers)
	"status.todo.desc": "Tareas esperando ser asignadas a un agente.",
	"status.inProgress.desc": "Un agente de IA está trabajando activamente en esta tarea.",
	"status.userQuestions.desc": "El agente necesita tu respuesta para continuar.",
	"status.reviewByAi.desc": "Revisión automática del trabajo completado. Puede devolver al agente para correcciones.",
	"status.reviewByUser.desc": "Listo para tu revisión. Crea un PR cuando estés satisfecho.",
	"status.reviewByColleague.desc": "PR creado y en revisión por bots o compañeros.",
	"status.completed.desc": "Listo — PR fusionado o tarea terminada.",
	"status.cancelled.desc": "Tarea cancelada y worktree eliminado.",

	// ActiveTasksSidebar
	"sidebar.activeTasks": "Tareas activas",
	"sidebar.noActiveTasks": "Sin tareas activas",
	"sidebar.noSearchResults": "No se encontraron tareas",
	"sidebar.searchPlaceholder": "Buscar tareas...",
	"sidebar.switchToBoard": "Mostrar tablero",
	"sidebar.switchToSidebar": "Mostrar panel",

	// Open in...
	"openIn.menuTitle": "Abrir en...",
	"openIn.noAppsFound": "No se encontraron aplicaciones externas",
	"openIn.failedOpen": "Error al abrir en {app}: {error}",

	// GitHub CLI warning banner
	"ghWarning.titleNotInstalled": "GitHub CLI (gh) no está instalado",
	"ghWarning.titleNotAuthenticated": "GitHub CLI (gh) no está autenticado",
	"ghWarning.messageNotInstalled": "Algunas funciones no estarán disponibles: detección automática de PR, promoción de tareas a \"Revisión PR\" y detección de fusiones vía GitHub. Instala gh y ejecuta `gh auth login`.",
	"ghWarning.messageNotAuthenticated": "Algunas funciones no estarán disponibles sin autenticación: detección automática de PR, promoción de tareas a \"Revisión PR\" y detección de fusiones vía GitHub. Ejecuta `gh auth login`.",
	"ghWarning.dismiss": "Entendido",
	"ghWarning.dontShowAgain": "No mostrar de nuevo",
};

export default common;
