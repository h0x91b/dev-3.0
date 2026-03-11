const columns = {
	// Custom Columns
	"customColumns.settingsTitle": "Custom Columns",
	"customColumns.settingsDesc": "Add columns to the Kanban board. Each column can include a short instruction for the AI agent explaining when to move a task there.",
	"customColumns.addColumn": "+ Add Column",
	"customColumns.noColumns": "No custom columns yet.",
	"customColumns.columnName": "Column name",
	"customColumns.llmInstruction": "LLM instruction (when to move here)",
	"customColumns.llmInstructionPlaceholder": "e.g. Move here when waiting for external feedback",
	"customColumns.deleteColumn": "Delete column",
	"customColumns.failedCreate": "Failed to create column: {error}",
	"customColumns.failedUpdate": "Failed to update column: {error}",
	"customColumns.failedDelete": "Failed to delete column: {error}",
	"customColumns.charCount": "{count}/{max}",

	// Labels
	"labels.filterTitle": "Labels",
	"labels.noLabels": "No labels yet. Type a name to create one.",
	"labels.createLabel": "Create \"{name}\"",
	"labels.searchPlaceholder": "Search or create...",
	"labels.addLabel": "+ Add Label",
	"labels.clearFilters": "Clear",
	"labels.searchPlaceholderTasks": "Search tasks...",
	"labels.deleteLabel": "Delete label",
	"labels.labelName": "Label name",
	"labels.settingsTitle": "Labels",
	"labels.settingsDesc": "Organize tasks by domain or theme",
	"labels.failedCreate": "Failed to create label: {error}",
	"labels.failedUpdate": "Failed to update label: {error}",
	"labels.failedDelete": "Failed to delete label: {error}",
	"labels.failedSetLabels": "Failed to update task labels: {error}",
	"labels.taskLabels": "Labels",

	// Notes
	"notes.title": "Notes",
	"notes.add": "+ Add Note",
	"notes.empty": "No notes yet",
	"notes.delete": "Delete note",
	"notes.sourceUser": "User",
	"notes.sourceAi": "AI",
	"notes.placeholder": "Write a note...",
	"notes.failedAdd": "Failed to add note: {error}",
	"notes.failedDelete": "Failed to delete note: {error}",

	// Images
	"images.pasting": "Pasting image...",
	"images.pasteFailed": "Failed to paste image",
	"images.loading": "Loading...",
	"images.loadFailed": "Load failed",
	"images.openInPreview": "Open in Preview",
	"images.close": "Close",
	"images.remove": "Remove image",
	"images.dropHere": "Drop file here",
} as const;

export default columns;
