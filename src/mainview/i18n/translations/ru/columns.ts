const columns = {
	// Custom Columns
	"customColumns.settingsTitle": "Пользовательские колонки",
	"customColumns.settingsDesc": "Добавьте колонки на доску Kanban. Каждая колонка может содержать краткую инструкцию для ИИ-агента о том, когда перемещать туда задачу.",
	"customColumns.addColumn": "+ Добавить колонку",
	"customColumns.addColumnAria": "Добавить колонку",
	"customColumns.defaultName": "Новая колонка",
	"customColumns.noColumns": "Пользовательских колонок пока нет.",
	"customColumns.columnName": "Название колонки",
	"customColumns.llmInstruction": "Инструкция для LLM (когда перемещать сюда)",
	"customColumns.llmInstructionPlaceholder": "напр. Переместить сюда, когда ожидается внешний отклик",
	"customColumns.deleteColumn": "Удалить колонку",
	"customColumns.failedCreate": "Ошибка создания колонки: {error}",
	"customColumns.failedUpdate": "Ошибка обновления колонки: {error}",
	"customColumns.failedDelete": "Ошибка удаления колонки: {error}",
	"customColumns.charCount": "{count}/{max}",

	// Labels
	"labels.filterTitle": "Метки",
	"labels.manageHint": "Чтобы переименовать, изменить цвет или удалить метку, откройте Настройки проекта → Метки.",
	"labels.noLabels": "Меток пока нет. Введите название для создания.",
	"labels.createLabel": "Создать \"{name}\"",
	"labels.searchPlaceholder": "Найти или создать...",
	"labels.addLabel": "+ Добавить метку",
	"labels.clearFilters": "Сбросить",
	"labels.searchPlaceholderTasks": "Поиск задач...",
	"labels.openFilters": "Фильтр по меткам",
	"labels.deleteLabel": "Удалить метку",
	"labels.labelName": "Название метки",
	"labels.settingsTitle": "Метки",
	"labels.settingsDesc": "Организуйте задачи по домену или теме",
	"labels.failedCreate": "Не удалось создать метку: {error}",
	"labels.failedUpdate": "Не удалось обновить метку: {error}",
	"labels.failedDelete": "Не удалось удалить метку: {error}",
	"labels.failedSetLabels": "Не удалось обновить метки задачи: {error}",
	"labels.taskLabels": "Метки",
	"labels.taskCount_one": "{count} задача",
	"labels.taskCount_few": "{count} задачи",
	"labels.taskCount_many": "{count} задач",
	"labels.taskCount_other": "{count} задач",

	// Priority
	"priority.label": "Приоритет",
	"priority.filterTitle": "Приоритет",
	"priority.pickerTitle": "Задать приоритет",
	"priority.badgeAria": "Приоритет {level} ({name}) — изменить",
	"priority.filterAria": "Фильтр по приоритету {level} ({name})",
	"priority.failedSet": "Не удалось задать приоритет: {error}",
	"priority.name.P0": "Наивысший",
	"priority.name.P1": "Высокий",
	"priority.name.P2": "Обычный",
	"priority.name.P3": "Низкий",
	"priority.name.P4": "Наименьший",

	// Token-DSL filter funnel (shared: board + sidebar)
	"filter.title": "Фильтры",
	"filter.funnelLabel": "Фильтровать задачи",
	"filter.group.priority": "Приоритет",
	"filter.group.status": "Статус",
	"filter.group.labels": "Метки",
	"filter.group.agents": "Агенты",
	"filter.group.flags": "Флаги",
	"filter.flag.attention": "Требует внимания",
	"filter.flag.port": "Есть открытый порт",
	"labels.moreLabels": "+{count} ещё",

	// Notes
	"notes.title": "Заметки",
	"notes.add": "+ Добавить заметку",
	"notes.empty": "Заметок пока нет",
	"notes.delete": "Удалить заметку",
	"notes.sourceUser": "Пользователь",
	"notes.sourceAi": "ИИ",
	"notes.placeholder": "Напишите заметку...",
	"notes.failedAdd": "Не удалось добавить заметку: {error}",
	"notes.failedDelete": "Не удалось удалить заметку: {error}",

	// Paste
	"paste.savingText": "Сохранение вставленного текста...",

	// Images
	"images.pasting": "Вставка изображения...",
	"images.pasteFailed": "Не удалось вставить изображение",
	"images.loading": "Загрузка...",
	"images.loadFailed": "Ошибка загрузки",
	"images.openInPreview": "Открыть в Preview",
	"images.close": "Закрыть",
	"images.remove": "Удалить изображение",
	"images.dropHere": "Перетащите файл сюда",

	// File attachments
	"attachments.openFile": "Открыть {name}",
	"attachments.removeFile": "Удалить файл",
};

export default columns;
