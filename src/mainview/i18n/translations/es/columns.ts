const columns = {
	// Custom Columns
	"customColumns.settingsTitle": "Columnas personalizadas",
	"customColumns.settingsDesc": "Añade columnas al tablero Kanban. Cada columna puede incluir una breve instrucción para el agente IA sobre cuándo mover una tarea allí.",
	"customColumns.addColumn": "+ Añadir columna",
	"customColumns.addColumnAria": "Añadir columna",
	"customColumns.defaultName": "Nueva columna",
	"customColumns.noColumns": "Aún no hay columnas personalizadas.",
	"customColumns.columnName": "Nombre de la columna",
	"customColumns.llmInstruction": "Instrucción para LLM (cuándo mover aquí)",
	"customColumns.llmInstructionPlaceholder": "ej. Mover aquí cuando se espera retroalimentación externa",
	"customColumns.deleteColumn": "Eliminar columna",
	"customColumns.failedCreate": "Error al crear columna: {error}",
	"customColumns.failedUpdate": "Error al actualizar columna: {error}",
	"customColumns.failedDelete": "Error al eliminar columna: {error}",
	"customColumns.charCount": "{count}/{max}",

	// Labels
	"labels.filterTitle": "Etiquetas",
	"labels.manageHint": "Para renombrar, recolorear o eliminar etiquetas, abre Ajustes del proyecto → Etiquetas.",
	"labels.noLabels": "Aún no hay etiquetas. Escribe un nombre para crear una.",
	"labels.createLabel": "Crear \"{name}\"",
	"labels.searchPlaceholder": "Buscar o crear...",
	"labels.addLabel": "+ Agregar etiqueta",
	"labels.clearFilters": "Limpiar",
	"labels.searchPlaceholderTasks": "Buscar tareas...",
	"labels.openFilters": "Filtrar por etiqueta",
	"labels.deleteLabel": "Eliminar etiqueta",
	"labels.labelName": "Nombre de etiqueta",
	"labels.settingsTitle": "Etiquetas",
	"labels.settingsDesc": "Organiza las tareas por dominio o tema",
	"labels.failedCreate": "Error al crear etiqueta: {error}",
	"labels.failedUpdate": "Error al actualizar etiqueta: {error}",
	"labels.failedDelete": "Error al eliminar etiqueta: {error}",
	"labels.failedSetLabels": "Error al actualizar etiquetas de tarea: {error}",
	"labels.taskLabels": "Etiquetas",

	// Priority
	"priority.label": "Prioridad",
	"priority.filterTitle": "Prioridad",
	"priority.pickerTitle": "Definir prioridad",
	"priority.badgeAria": "Prioridad {level} ({name}) — cambiar",
	"priority.filterAria": "Filtrar por prioridad {level} ({name})",
	"priority.failedSet": "No se pudo definir la prioridad: {error}",
	"priority.name.P0": "Máxima",
	"priority.name.P1": "Alta",
	"priority.name.P2": "Normal",
	"priority.name.P3": "Baja",
	"priority.name.P4": "Mínima",

	// Token-DSL filter funnel (shared: board + sidebar)
	"filter.title": "Filtros",
	"filter.funnelLabel": "Filtrar tareas",
	"filter.group.priority": "Prioridad",
	"filter.group.status": "Estado",
	"filter.group.labels": "Etiquetas",
	"filter.group.agents": "Agentes",
	"filter.group.flags": "Indicadores",
	"filter.flag.attention": "Requiere atención",
	"filter.flag.port": "Con puerto activo",
	"labels.moreLabels": "+{count} más",

	// Notes
	"notes.title": "Notas",
	"notes.add": "+ Agregar nota",
	"notes.empty": "Aún no hay notas",
	"notes.delete": "Eliminar nota",
	"notes.sourceUser": "Usuario",
	"notes.sourceAi": "IA",
	"notes.placeholder": "Escribe una nota...",
	"notes.failedAdd": "Error al agregar nota: {error}",
	"notes.failedDelete": "Error al eliminar nota: {error}",

	// Paste
	"paste.savingText": "Guardando texto pegado...",

	// Images
	"images.pasting": "Pegando imagen...",
	"images.pasteFailed": "Error al pegar imagen",
	"images.loading": "Cargando...",
	"images.loadFailed": "Error al cargar",
	"images.openInPreview": "Abrir en Preview",
	"images.close": "Cerrar",
	"images.remove": "Eliminar imagen",
	"images.dropHere": "Suelta el archivo aquí",

	// File attachments
	"attachments.openFile": "Abrir {name}",
	"attachments.removeFile": "Eliminar archivo",
};

export default columns;
