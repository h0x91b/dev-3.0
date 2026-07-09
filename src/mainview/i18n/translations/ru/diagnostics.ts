const diagnostics = {
	// ── Bootstrap / loading screen ──
	"boot.phase.connecting": "Подключение к вашему компьютеру…",
	"boot.phase.authenticating": "Аутентификация…",
	"boot.phase.reconnecting": "Переподключение…",
	"boot.phase.checking": "Проверка системы…",
	"boot.phase.loading": "Загрузка ваших проектов…",
	"boot.stuck.title": "Это занимает больше времени, чем обычно",
	"boot.stuck.connecting":
		"dev-3.0 не может связаться с вашим компьютером. Проверьте, что удалённый сервер ещё работает и соединение стабильно.",
	"boot.stuck.generic": "Похоже, запуск завис. Повторите попытку или перезагрузите приложение.",
	"boot.connection": "Соединение",
	"boot.lastError": "Последняя ошибка",
	"boot.retry": "Повторить",
	"boot.reload": "Перезагрузить",
	"boot.showDetails": "Показать детали",

	// ── Diagnostics panel ──
	"diagnostics.title": "Диагностика",
	"diagnostics.subtitle": "Ошибки, пойманные в этой сессии",
	"diagnostics.empty": "Ошибок не зафиксировано. Всё выглядит здоровым.",
	"diagnostics.copyAll": "Копировать всё",
	"diagnostics.copied": "Скопировано",
	"diagnostics.clear": "Очистить",
	"diagnostics.close": "Закрыть",
	"diagnostics.reload": "Перезагрузить приложение",
	"diagnostics.detail": "Детали",

	// Kind labels
	"diagnostics.kind.error": "Ошибка",
	"diagnostics.kind.rejection": "Необработанное отклонение",
	"diagnostics.kind.react": "Сбой рендеринга",
	"diagnostics.kind.rpc": "Соединение",

	// Connection-state labels
	"diagnostics.conn.connected": "Подключено",
	"diagnostics.conn.connecting": "Подключение",
	"diagnostics.conn.authenticating": "Аутентификация",
	"diagnostics.conn.reconnecting": "Переподключение",
	"diagnostics.conn.closed": "Отключено",
	"diagnostics.conn.authFailed": "Ошибка аутентификации",

	// Floating indicator (remote only, shown when errors exist)
	"diagnostics.indicatorLabel": "Показать диагностику",
	"diagnostics.issues_one": "{count} проблема",
	"diagnostics.issues_few": "{count} проблемы",
	"diagnostics.issues_many": "{count} проблем",
	"diagnostics.issues_other": "{count} проблем",
} as const;

export default diagnostics;
