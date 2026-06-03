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

	// Generic confirmation dialog (imperative confirm() service)
	"confirmDialog.confirm": "OK",
	"confirmDialog.cancel": "Cancelar",

	// About dialog (in-app, replaces the native About message box)
	"about.version": "Versión {version}",
	"about.tagline": "Gestor de proyectos centrado en la terminal",
	"about.builtWith": "Hecho con Electrobun, React y Bun.",
	"about.website": "Sitio web",
	"about.close": "Cerrar",

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
	"status.reviewByAi.desc": "Arrastra una tarea aquí para lanzar un agente de revisión IA. Busca errores y corrige problemas medios/altos.",
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
	"sidebar.hide": "Zoom del terminal (ocultar Tareas activas)",
	"sidebar.scopeProject": "Solo este proyecto",
	"sidebar.scopeGlobal": "Todos los proyectos",
	"sidebar.scopeToggleTitle": "Alternar alcance (este proyecto / todos los proyectos)",
	"sidebar.globalLoading": "Cargando tareas de todos los proyectos…",
	"sidebar.unknownProject": "Proyecto desconocido",

	// Open in...
	"openIn.menuTitle": "Abrir en...",
	"openIn.noAppsFound": "No se encontraron aplicaciones externas",
	"openIn.failedOpen": "Error al abrir en {app}: {error}",
	"openIn.copyPath": "Copiar ruta",
	"openIn.pathCopied": "¡Copiado!",

	// GitHub CLI warning banner
	"ghWarning.titleNotInstalled": "GitHub CLI (gh) no está instalado",
	"ghWarning.titleNotAuthenticated": "GitHub CLI (gh) no está autenticado",
	"ghWarning.messageNotInstalled": "Algunas funciones no estarán disponibles: detección automática de PR, promoción de tareas a \"Revisión PR\" y detección de fusiones vía GitHub. Instala gh y ejecuta `gh auth login`.",
	"ghWarning.messageNotAuthenticated": "Algunas funciones no estarán disponibles sin autenticación: detección automática de PR, promoción de tareas a \"Revisión PR\" y detección de fusiones vía GitHub. Ejecuta `gh auth login`.",
	"ghWarning.dismiss": "Entendido",
	"ghWarning.dontShowAgain": "No mostrar de nuevo",

	// Folder picker (custom modal — works in both desktop and remote/browser modes)
	"folderPicker.title": "Selecciona una carpeta",
	"folderPicker.home": "Inicio",
	"folderPicker.rootLabel": "Raíz",
	"folderPicker.loading": "Cargando…",
	"folderPicker.pathPlaceholder": "Pega una ruta, Enter",
	"folderPicker.filterPlaceholder": "Filtrar carpetas…",
	"folderPicker.sectionPlaces": "Lugares",
	"folderPicker.sectionRecent": "Recientes",
	"folderPicker.selected": "Seleccionado",
	"folderPicker.select": "Seleccionar",
	"folderPicker.cancel": "Cancelar",
	"folderPicker.newFolder": "Nueva carpeta",
	"folderPicker.newFolderTitle": "Crear una nueva carpeta aquí",
	"folderPicker.newFolderPlaceholder": "Nombre de la carpeta",
	"folderPicker.create": "Crear",
	"folderPicker.creating": "Creando…",

	// Stuck preparation popover (clone hangs on Fetching origin — macOS FDA)
	"stuckPrep.popoverTitle": "¿Atascado en Fetching origin?",
	"stuckPrep.popoverBody": "En macOS esto casi siempre es un problema de Acceso completo al disco — git y tmux pierden silenciosamente el acceso a .git. Concede Acceso completo al disco a dev-3.0 y la clonación se reanudará.",
	"stuckPrep.popoverCancel": "Cancelar tarea",
	"stuckPrep.popoverOpenSettings": "Abrir Acceso completo al disco",

	// Unsaved changes guard
	"unsavedChanges.title": "Cambios sin guardar",
	"unsavedChanges.message": "Tienes cambios sin guardar en la configuración del proyecto. ¿Qué deseas hacer?",
	"unsavedChanges.save": "Guardar",
	"unsavedChanges.discard": "Descartar",
	"unsavedChanges.cancel": "Cancelar",
	"unsavedChanges.banner": "Tienes cambios sin guardar",
};

export default common;
