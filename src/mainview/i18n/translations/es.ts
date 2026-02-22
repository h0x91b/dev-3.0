import type { TranslationRecord } from "./en";

const es: TranslationRecord & Record<string, string> = {
	// App
	"app.loading": "Cargando...",

	// Dashboard
	"dashboard.noProjects": "Aún no hay proyectos",
	"dashboard.noProjectsHint": "Agrega un repositorio git para comenzar",
	"dashboard.addProject": "Agregar proyecto",
	"dashboard.remove": "Eliminar",
	"dashboard.confirmRemove": "¿Eliminar este proyecto de la lista?",
	"dashboard.failedAdd": "Error al agregar proyecto: {error}",
	"dashboard.failedRemove": "Error al eliminar proyecto: {error}",
	"dashboard.projectCount_one": "{count} proyecto",
	"dashboard.projectCount_other": "{count} proyectos",

	// GlobalHeader
	"header.task": "Tarea",
	"header.settings": "Configuración",
	"header.projectSettings": "Configuración del proyecto",

	// GlobalSettings
	"settings.theme": "Tema",
	"settings.themeDark": "Oscuro",
	"settings.themeDarkDesc": "Índigo nocturno",
	"settings.themeLight": "Claro",
	"settings.themeLightDesc": "Limpio y brillante",
	"settings.language": "Idioma",

	// KanbanColumn
	"kanban.noTasks": "Sin tareas",
	"kanban.taskPlaceholder": "Título de la tarea...",
	"kanban.add": "Agregar",
	"kanban.cancel": "Cancelar",
	"kanban.newTask": "+ Nueva tarea",
	"kanban.failedCreate": "Error al crear tarea: {error}",

	// CreateTaskModal
	"createTask.title": "Nueva tarea",
	"createTask.nameLabel": "Título",
	"createTask.statusLabel": "Estado",
	"createTask.create": "Crear",
	"createTask.creating": "Creando...",

	// TaskCard
	"task.moveTo": "Mover a",
	"task.delete": "Eliminar",
	"task.confirmDelete": "¿Eliminar tarea \"{title}\"?",
	"task.failedMove": "Error al mover tarea: {error}",
	"task.failedDelete": "Error al eliminar tarea: {error}",

	// ProjectSettings
	"projectSettings.setupScript": "Script de configuración",
	"projectSettings.setupScriptDesc":
		"Se ejecuta en el directorio worktree después de la creación",
	"projectSettings.defaultCommand": "Comando predeterminado",
	"projectSettings.defaultCommandDesc":
		"Comando para ejecutar en tmux para nuevas tareas",
	"projectSettings.baseBranch": "Rama base",
	"projectSettings.baseBranchDesc":
		"Rama desde la cual se crean los worktrees",
	"projectSettings.save": "Guardar configuración",
	"projectSettings.saving": "Guardando...",
	"projectSettings.failedSave": "Error al guardar configuración: {error}",

	// ProjectView
	"project.notFound": "Proyecto no encontrado",

	// TaskTerminal
	"terminal.connecting": "Conectando...",

	// Status labels
	"status.todo": "Por hacer",
	"status.inProgress": "En progreso",
	"status.userQuestions": "Preguntas del usuario",
	"status.reviewByAi": "Revisión por IA",
	"status.reviewByUser": "Revisión por usuario",
	"status.completed": "Completado",
	"status.cancelled": "Cancelado",
};

export default es;
