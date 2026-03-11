const common = {
	// App
	"app.loading": "Загрузка...",
	"app.branchMergedTitle": "Ветка смержена",
	"app.branchMergedMessage": "Все изменения из «{branchName}» уже в основной ветке.\n\nЗадача: {taskTitle}\n\nПеревести задачу в «Завершено»?",

	// Quit dialog
	"quit.dialogTitle": "Сессии продолжают работать",
	"quit.dialogMessage": "Ваши терминальные сессии продолжат работать в tmux после выхода. Вы сможете подключиться к ним при следующем запуске приложения.",
	"quit.dontShowAgain": "Больше не показывать",
	"quit.confirm": "Выйти",
	"quit.cancel": "Отмена",

	// Status labels
	"status.todo": "К выполнению",
	"status.inProgress": "Агент работает",
	"status.userQuestions": "Есть вопросы",
	"status.reviewByAi": "Ревью ИИ",
	"status.reviewByUser": "Ваше ревью",
	"status.reviewByColleague": "Ревью PR",
	"status.completed": "Завершено",
	"status.cancelled": "Отменено",

	// Status descriptions (info tooltips for column headers)
	"status.todo.desc": "Задачи, ожидающие назначения агенту.",
	"status.inProgress.desc": "ИИ-агент активно работает над задачей.",
	"status.userQuestions.desc": "Агенту нужен ваш ответ, чтобы продолжить.",
	"status.reviewByAi.desc": "Автоматическое ревью выполненной работы. Может вернуть агенту на доработку.",
	"status.reviewByUser.desc": "Готово к вашему ревью. Создайте PR, если всё устраивает.",
	"status.reviewByColleague.desc": "PR создан и проходит ревью ботами или коллегами.",
	"status.completed.desc": "Готово — PR замержен или задача завершена.",
	"status.cancelled.desc": "Задача отменена, worktree удалён.",

	// ActiveTasksSidebar
	"sidebar.activeTasks": "Активные задачи",
	"sidebar.noActiveTasks": "Нет активных задач",
	"sidebar.switchToBoard": "Показать доску",
	"sidebar.switchToSidebar": "Показать панель",

	// Open in...
	"openIn.menuTitle": "Открыть в...",
	"openIn.noAppsFound": "Не найдены внешние приложения",
	"openIn.failedOpen": "Не удалось открыть в {app}: {error}",

	// GitHub CLI warning banner
	"ghWarning.titleNotInstalled": "GitHub CLI (gh) не установлен",
	"ghWarning.titleNotAuthenticated": "GitHub CLI (gh) не авторизован",
	"ghWarning.messageNotInstalled": "Без него некоторые функции не будут работать: автоматическое обнаружение PR, перевод задачи в статус «Ревью PR» и определение слияния через GitHub. Установите gh и выполните `gh auth login`.",
	"ghWarning.messageNotAuthenticated": "Без авторизации некоторые функции не будут работать: автоматическое обнаружение PR, перевод задачи в статус «Ревью PR» и определение слияния через GitHub. Выполните `gh auth login`.",
	"ghWarning.dismiss": "Понятно",
	"ghWarning.dontShowAgain": "Больше не показывать",
};

export default common;
