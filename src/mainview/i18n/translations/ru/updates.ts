const updates = {
	// Update
	"update.checkingTitle": "Проверка обновлений",
	"update.upToDate": "У вас последняя версия!",
	"update.availableTitle": "Доступно обновление",
	"update.availableMessage": "Доступна версия {version}. Хотите скачать?",
	"update.downloadBtn": "Скачать",
	"update.laterBtn": "Позже",
	"update.errorTitle": "Ошибка проверки обновлений",
	"update.readyLabel": "Обновить",
	"update.readyTooltip": "Версия {version} готова к установке",
	"update.readyTitle": "v{version} готова к установке",
	"update.sessionsNote": "Все терминальные сессии сохранятся — tmux продолжит работать в фоне.",
	"update.restartBtn": "Перезапустить",
	"update.restartCountdown": "Перезапустить ({seconds}с)",
	"update.postponeBtn": "Отложить",
	"update.restarting": "Перезапуск...",
	"update.checking": "Проверка...",
	"update.downloading": "Загрузка...",
	"update.upToDateVersion": "У вас последняя версия — v{version}",
	"update.checkFailedDetail": "Не удалось проверить обновления: {error}",
	"update.applyFailed": "Не удалось применить обновление: {error}",

	// Rosetta warning (Intel build on Apple Silicon)
	"rosetta.title": "Intel-сборка на Apple Silicon",
	"rosetta.body":
		"Эта копия dev-3.0 — Intel-сборка (x64), работающая через Rosetta 2. Она медленнее, а macOS прекращает поддержку Rosetta — скоро приложение вовсе перестанет запускаться.",
	"rosetta.instructionBrew": "Закройте dev-3.0, вставьте команду в Терминал, затем запустите dev-3.0 снова:",
	"rosetta.instructionDmg":
		"Вставьте команду в Терминал, затем перетащите dev-3.0 в Applications (заменив старую версию) и перезапустите:",
	"rosetta.dataSafe": "Ваши проекты, задачи и настройки не пострадают.",
	"rosetta.copyBtn": "Скопировать команду",
	"rosetta.copiedBtn": "Скопировано!",
	"rosetta.laterBtn": "Напомнить позже",

	// Requirements
	"requirements.title": "Системные требования",
	"requirements.subtitle": "Для работы dev-3.0 необходимы следующие инструменты",
	"requirements.installed": "Установлено",
	"requirements.missing": "Не найдено",
	"requirements.refresh": "Проверить снова",
	"requirements.copied": "Скопировано!",
	"requirements.installGit": "Установить через Xcode CLI tools:",
	"requirements.installTmux": "Установить через Homebrew:",
	"requirements.installYazi": "Установить через Homebrew (опционально, для файлового браузера):",
	"requirements.optional": "опционально",
	"requirements.customPathHint": "Или укажите полный путь к бинарнику:",
	"requirements.pathNotFound": "Сохранённый путь отсутствует или не указывает на исполняемый файл",
	"requirements.pathInvalidBinary": "Путь должен вести к исполняемому файлу {name}",
	"requirements.setPath": "Указать путь",

	// Changelog
	"changelog.loading": "Загрузка...",
	"changelog.empty": "Записей пока нет",
	"changelog.feature": "фича",
	"changelog.fix": "фикс",
	"changelog.refactor": "рефакторинг",
	"changelog.docs": "документация",
	"changelog.chore": "служебное",
	"changelog.filterLabel": "Фильтр:",
	"changelog.clearFilter": "сбросить",
};

export default updates;
