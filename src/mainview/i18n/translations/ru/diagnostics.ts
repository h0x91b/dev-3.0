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
	// Floating connection pill (remote only, shown while the transport is unhealthy)
	"conn.pill.retry": "Нажмите, чтобы повторить",
	"conn.pill.retryAria": "Соединение потеряно — переподключиться",
	"conn.pill.restored": "Связь восстановлена",
	// ── Remote connection quality (header readout) ──
	"connQuality.title": "Качество соединения",
	"connQuality.label": "Соединение",
	"connQuality.definition": "Полный оборот одного запроса через то же соединение, которым живёт приложение.",
	"connQuality.ariaLabel": "Оборот соединения {ms} мс — открыть разбор",
	"connQuality.median": "Обычный оборот",
	"connQuality.p95": "Самый медленный из 20",
	"connQuality.jitter": "Разброс",
	"connQuality.ours": "Ушло на этом компьютере",
	"connQuality.network": "Ушло на сеть",
	"connQuality.path": "Маршрут",
	"connQuality.pathTunnel": "Туннель Cloudflare",
	"connQuality.pathLan": "Напрямую, локальная сеть",
	"connQuality.pathLocal": "Та же машина",
	"connQuality.samples": "Замеров",
	"connQuality.samplesWithLoss": "{count} (потеряно {lost})",
	"connQuality.host": "Адрес",
	"connQuality.compareHint": "Это весь путь целиком. Чтобы обвинить туннель, откройте прямой адрес в локальной сети и сравните то же число.",
} as const;

export default diagnostics;
