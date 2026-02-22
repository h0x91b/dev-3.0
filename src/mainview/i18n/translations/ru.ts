import type { TranslationRecord } from "./en";

const ru: TranslationRecord & Record<string, string> = {
	// App
	"app.loading": "Загрузка...",

	// Dashboard
	"dashboard.noProjects": "Пока нет проектов",
	"dashboard.noProjectsHint": "Добавьте git-репозиторий, чтобы начать",
	"dashboard.addProject": "Добавить проект",
	"dashboard.remove": "Удалить",
	"dashboard.confirmRemove": "Убрать этот проект из списка?",
	"dashboard.failedAdd": "Не удалось добавить проект: {error}",
	"dashboard.failedRemove": "Не удалось удалить проект: {error}",
	"dashboard.projectCount_one": "{count} проект",
	"dashboard.projectCount_few": "{count} проекта",
	"dashboard.projectCount_many": "{count} проектов",
	"dashboard.projectCount_other": "{count} проектов",

	// GlobalHeader
	"header.task": "Задача",
	"header.settings": "Настройки",
	"header.projectSettings": "Настройки проекта",

	// GlobalSettings
	"settings.theme": "Тема",
	"settings.themeDark": "Тёмная",
	"settings.themeDarkDesc": "Полуночный индиго",
	"settings.themeLight": "Светлая",
	"settings.themeLightDesc": "Чистая и яркая",
	"settings.language": "Язык",
	"settings.agents": "Кодинг-агенты",
	"settings.builtinAgents": "Встроенные агенты",
	"settings.customAgents": "Пользовательские агенты",
	"settings.noCustomAgents": "Пользовательских агентов пока нет",
	"settings.addCustomAgent": "Добавить агента",
	"settings.customAgentName": "Название",
	"settings.customAgentCommand": "Команда",
	"settings.customAgentCommandHint": "Shell-команда. Доступны переменные: $DEV3_TASK_TITLE, $DEV3_TASK_ID, $DEV3_PROJECT_NAME, $DEV3_PROJECT_PATH, $DEV3_WORKTREE_PATH.",
	"settings.deleteAgent": "Удалить",
	"settings.builtinBadge": "Встроенный",

	// KanbanColumn
	"kanban.noTasks": "Нет задач",
	"kanban.add": "Добавить",
	"kanban.cancel": "Отмена",
	"kanban.newTask": "+ Новая задача",
	"kanban.failedCreate": "Не удалось создать задачу: {error}",

	// CreateTaskModal
	"createTask.title": "Новая задача",
	"createTask.descriptionLabel": "Описание",
	"createTask.descriptionPlaceholder": "Опишите, что нужно сделать...",
	"createTask.generatedTitle": "Заголовок:",
	"createTask.statusLabel": "Статус",
	"createTask.create": "Создать",
	"createTask.creating": "Создаётся...",
	"createTask.submitHint": "\u2318Enter для создания",

	// TaskCard
	"task.moveTo": "Переместить в",
	"task.delete": "Удалить",
	"task.confirmDelete": "Удалить задачу «{title}»?",
	"task.failedMove": "Не удалось переместить задачу: {error}",
	"task.failedDelete": "Не удалось удалить задачу: {error}",

	// ProjectSettings
	"projectSettings.setupScript": "Скрипт настройки",
	"projectSettings.setupScriptDesc":
		"Запускается в директории worktree после создания",
	"projectSettings.agent": "Кодинг-агент",
	"projectSettings.agentDesc": "Агент для запуска в tmux для новых задач",
	"projectSettings.customCommand": "Произвольная команда",
	"projectSettings.defaultCommand": "Команда по умолчанию",
	"projectSettings.defaultCommandDesc":
		"Команда для запуска в tmux для новых задач",
	"projectSettings.baseBranch": "Базовая ветка",
	"projectSettings.baseBranchDesc": "Ветка, от которой создаются worktree",
	"projectSettings.save": "Сохранить настройки",
	"projectSettings.saving": "Сохранение...",
	"projectSettings.failedSave": "Не удалось сохранить настройки: {error}",

	// ProjectView
	"project.notFound": "Проект не найден",

	// TaskTerminal
	"terminal.connecting": "Подключение...",

	// Status labels
	"status.todo": "К выполнению",
	"status.inProgress": "В работе",
	"status.userQuestions": "Вопросы пользователя",
	"status.reviewByAi": "Ревью ИИ",
	"status.reviewByUser": "Ревью пользователя",
	"status.completed": "Завершено",
	"status.cancelled": "Отменено",
};

export default ru;
