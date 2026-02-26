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
	"header.globalSettingsTooltip": "Configuración global (\u2318,)",
	"header.projLabel": "Proy",
	"header.globalLabel": "Global",

	// GlobalSettings
	"settings.theme": "Tema",
	"settings.themeDark": "Oscuro",
	"settings.themeDarkDesc": "Índigo nocturno",
	"settings.themeLight": "Claro",
	"settings.themeLightDesc": "Limpio y brillante",
	"settings.language": "Idioma",
	"settings.agents": "Agentes de código",
	"settings.addAgent": "Agregar agente",
	"settings.agentName": "Nombre",
	"settings.agentBaseCommand": "Comando base",
	"settings.configurations": "Configuraciones",
	"settings.addConfig": "Agregar configuración",
	"settings.configName": "Nombre",
	"settings.configModel": "Modelo",
	"settings.configAppendPrompt": "Prompt adicional",
	"settings.configAppendPromptHint": "Se agrega a la descripción de la tarea. Variables: {{TASK_TITLE}}, {{TASK_DESCRIPTION}}, {{PROJECT_NAME}}, {{PROJECT_PATH}}, {{WORKTREE_PATH}}.",
	"settings.configAdditionalArgs": "Argumentos adicionales",
	"settings.configAddArg": "Agregar argumento",
	"settings.configEnvVars": "Variables de entorno",
	"settings.configAddEnvVar": "Agregar variable",
	"settings.configBaseCommandOverride": "Sobreescribir comando base",
	"settings.deleteAgent": "Eliminar",
	"settings.deleteConfig": "Eliminar configuración",
	"settings.commandPreview": "Vista previa del comando",
	"settings.defaultBadge": "Predeterminado",
	"settings.configPermissionMode": "Modo de permisos",
	"settings.permDefault": "Predeterminado",
	"settings.permPlan": "Modo plan",
	"settings.permAcceptEdits": "Aceptar ediciones",
	"settings.permDontAsk": "No preguntar",
	"settings.permBypass": "Sin restricciones",
	"settings.configEffort": "Nivel de esfuerzo",
	"settings.effortDefault": "Predeterminado",
	"settings.effortLow": "Bajo",
	"settings.effortMedium": "Medio",
	"settings.effortHigh": "Alto",
	"settings.configMaxBudget": "Presupuesto máximo (USD)",
	"settings.configMaxBudgetHint": "Monto máximo para llamadas API por sesión",
	"settings.cantDeleteDefault": "Los agentes predeterminados no se pueden eliminar",
	"settings.defaultAgent": "Agente predeterminado",
	"settings.defaultAgentDesc": "Agente utilizado para nuevas tareas",
	"settings.defaultConfig": "Configuración predeterminada",
	"settings.defaultConfigDesc": "Configuración aplicada al lanzar tareas",

	// KanbanColumn
	"kanban.noTasks": "Sin tareas",
	"kanban.add": "Agregar",
	"kanban.cancel": "Cancelar",
	"kanban.newTask": "+ Nueva tarea",
	"kanban.failedCreate": "Error al crear tarea: {error}",

	// CreateTaskModal
	"createTask.title": "Nueva tarea",
	"createTask.descriptionLabel": "Descripción",
	"createTask.descriptionPlaceholder": "Describe lo que hay que hacer...",
	"createTask.generatedTitle": "Título:",
	"createTask.statusLabel": "Estado",
	"createTask.create": "Crear",
	"createTask.creating": "Creando...",
	"createTask.submitHint": "\u2318Enter para crear",

	// TaskCard
	"task.moveTo": "Mover a",
	"task.delete": "Eliminar",
	"task.confirmDelete": "¿Eliminar tarea \"{title}\"?",
	"task.failedMove": "Error al mover tarea: {error}",
	"task.failedDelete": "Error al eliminar tarea: {error}",
	"task.run": "Ejecutar",
	"task.cancel": "Cancelar",
	"task.confirmCancel": "¿Cancelar tarea \"{title}\"?",
	"task.variant": "#{n}",

	// LaunchVariantsModal
	"launch.title": "Lanzar tarea",
	"launch.agent": "Agente",
	"launch.config": "Configuración",
	"launch.addVariant": "+ Agregar variante",
	"launch.removeVariant": "Eliminar",
	"launch.launch": "Lanzar",
	"launch.launching": "Lanzando...",
	"launch.failedLaunch": "Error al lanzar: {error}",

	// ProjectSettings
	"projectSettings.setupScript": "Script de configuración",
	"projectSettings.setupScriptDesc":
		"Se ejecuta en el directorio worktree después de la creación",
	"projectSettings.devScript": "Script de desarrollo",
	"projectSettings.devScriptDesc":
		"Se ejecuta al iniciar el servidor de desarrollo de este proyecto",
	"projectSettings.cleanupScript": "Script de limpieza",
	"projectSettings.cleanupScriptDesc":
		"Se ejecuta cuando una tarea se mueve a Cancelled (o Archived en el futuro)",
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
