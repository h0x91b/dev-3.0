const diagnostics = {
	// ── Bootstrap / loading screen ──
	"boot.phase.connecting": "Conectando con tu ordenador…",
	"boot.phase.authenticating": "Autenticando…",
	"boot.phase.reconnecting": "Reconectando…",
	"boot.phase.checking": "Comprobando el sistema…",
	"boot.phase.loading": "Cargando tus proyectos…",
	"boot.stuck.title": "Esto está tardando más de lo normal",
	"boot.stuck.connecting":
		"dev-3.0 no puede conectar con tu ordenador. Comprueba que el servidor remoto sigue activo y que tu conexión es estable.",
	"boot.stuck.generic": "El arranque parece atascado. Reintenta o recarga la aplicación.",
	"boot.connection": "Conexión",
	"boot.lastError": "Último error",
	"boot.retry": "Reintentar",
	"boot.reload": "Recargar",
	"boot.showDetails": "Ver detalles",

	// ── Diagnostics panel ──
	"diagnostics.title": "Diagnóstico",
	"diagnostics.subtitle": "Errores capturados en esta sesión",
	"diagnostics.empty": "No se capturaron problemas. Todo parece correcto.",
	"diagnostics.copyAll": "Copiar todo",
	"diagnostics.copied": "Copiado",
	"diagnostics.clear": "Limpiar",
	"diagnostics.close": "Cerrar",
	"diagnostics.reload": "Recargar la aplicación",
	"diagnostics.detail": "Detalles",

	// Kind labels
	"diagnostics.kind.error": "Error",
	"diagnostics.kind.rejection": "Rechazo no controlado",
	"diagnostics.kind.react": "Fallo de renderizado",
	"diagnostics.kind.rpc": "Conexión",

	// Connection-state labels
	"diagnostics.conn.connected": "Conectado",
	"diagnostics.conn.connecting": "Conectando",
	"diagnostics.conn.authenticating": "Autenticando",
	"diagnostics.conn.reconnecting": "Reconectando",
	"diagnostics.conn.closed": "Desconectado",
	"diagnostics.conn.authFailed": "Error de autenticación",

	// Floating indicator (remote only, shown when errors exist)
	"diagnostics.indicatorLabel": "Ver diagnóstico",
	"diagnostics.issues_one": "{count} problema",
	"diagnostics.issues_other": "{count} problemas",
} as const;

export default diagnostics;
