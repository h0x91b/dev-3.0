// Rich tooltip details (`ttip.*`) — Spanish.
export const tooltips = {
	// Global header
	"ttip.header.navBack":
		"El historial de navegación funciona como un navegador: cada tablero, tarea y pantalla de ajustes que visitas se convierte en un paso al que puedes volver.",
	"ttip.header.navForward": "Vuelve a la pantalla de la que acabas de retroceder. El historial guarda tus pantallas recientes en orden.",
	"ttip.header.switchProject": "Salta directamente al tablero de otro proyecto sin pasar por el panel principal.",
	"ttip.header.updateReady": "Hay una versión nueva descargada y lista. Haz clic para reiniciar la app y aplicarla.",
	"ttip.header.quickShell":
		"Una terminal desechable para comandos rápidos. Corre como tarea scratch en el tablero Operations, así que no toca los worktrees de tus proyectos.",
	"ttip.header.projectTerminal": "Una terminal en la carpeta raíz del proyecto — el árbol de trabajo principal, no el worktree de una tarea.",
	"ttip.header.remoteAccess":
		"Sirve esta app a tu teléfono u otro navegador mediante un túnel seguro. Observa a los agentes y responde sus preguntas desde cualquier lugar.",
	"ttip.header.stats": "Tareas completadas, líneas cambiadas y velocidad de los agentes en el tiempo — por proyecto y en total.",
	"ttip.header.github": "Abre el repositorio de GitHub de este proyecto en tu navegador.",
	"ttip.header.reportBug": "¿Algo en dev-3.0 no funciona? Crea un issue de GitHub desde aquí mismo.",
	"ttip.header.changelog": "Novedades de dev-3.0 — funciones y arreglos agrupados por día de lanzamiento.",
	"ttip.header.moreActions": "Las acciones que no caben en la barra con este ancho de ventana viven aquí.",
	"ttip.header.projectSettings":
		"Todo a nivel de proyecto: scripts de ciclo de vida, rama base, asignación de puertos, columnas personalizadas, revisión por IA.",
	"ttip.header.globalSettings": "Preferencias de toda la app: agentes, apariencia, comportamiento, idioma e integraciones.",

	// Task card
	"ttip.task.openPR": "El estado del pull request de un vistazo — abierto, fusionado o cerrado. Clic para verlo en GitHub.",
	"ttip.task.ci": "Estado en vivo del CI del pull request de esta tarea. Clic para abrir las comprobaciones en GitHub.",
	"ttip.task.review": "Estado de revisión del pull request — aprobado, cambios solicitados o aún esperando revisor.",
	"ttip.task.showDescription": "Lee la descripción completa de la tarea sin abrirla.",
	"ttip.task.cancel":
		"Detiene al agente y elimina el worktree de la tarea (tras ejecutar el script de limpieza). La tarjeta pasa a Cancelled.",
	"ttip.task.delete": "Elimina definitivamente esta tarea cancelada del tablero.",
	"ttip.task.watch":
		"Las tareas observadas te notifican cuando el agente termina, falla o pregunta algo — puedes alejarte tranquilo.",
	"ttip.task.siblings":
		"Esta tarea tiene variantes hermanas — agentes independientes intentando el mismo trabajo en paralelo. Cada punto es el estado de una variante; clic para saltar entre ellas.",
	"ttip.task.ports":
		"Puertos de red asignados a esta tarea. Cada tarea tiene los suyos, así los dev servers paralelos nunca chocan.",
	"ttip.task.run": "Crea el git worktree, abre la terminal y lanza el agente en esta tarea.",
	"ttip.task.addVariant":
		"Lanza un agente más sobre la misma tarea en su propio worktree. Las variantes exploran de forma independiente — compara resultados y quédate con el mejor.",

	// Task info panel
	"ttip.infoPanel.includeTests":
		"Cuando está apagado, los archivos de test se excluyen del diff y de los contadores +/− — ves solo la huella del código de producción.",
	"ttip.infoPanel.showDiff": "Todo lo que cambió esta tarea, comparado con la rama base.",
	"ttip.infoPanel.spawnAgent":
		"Añade otro panel de agente a la ventana tmux de esta tarea. Ambos agentes comparten el mismo worktree — útil para un ayudante o un revisor.",
	"ttip.infoPanel.bugHunters":
		"Lanza varios agentes de solo lectura que peinan este worktree en paralelo buscando bugs y reportan lo que encuentran. No pueden modificar archivos.",
	"ttip.infoPanel.worktreeConfig": "Ajustes específicos de cómo se prepara el worktree de esta tarea.",
	"ttip.infoPanel.copyPath": "Copia la ruta absoluta del git worktree de esta tarea — pégala en cualquier terminal o editor.",
	"ttip.infoPanel.actions": "Todas las acciones de la tarea en una hoja: git, scripts, dev server, abrir-en y más.",
	"ttip.infoPanel.fullScreen": "La terminal ocupa toda la ventana. Pulsa de nuevo para volver.",
	"ttip.infoPanel.expand": "Abre el panel completo: acciones git, scripts, dev server y controles de ejecución.",
	"ttip.infoPanel.collapse": "Reduce el panel a una sola fila compacta.",

	// tmux pane controls
	"ttip.tmux.splitH":
		"tmux: divide el panel actual en dos, lado a lado. Ejecuta un shell, un tail de logs o una segunda herramienta junto al agente.",
	"ttip.tmux.splitV": "tmux: divide el panel actual en dos, apilados — el nuevo se abre debajo del activo.",
	"ttip.tmux.nextLayout": "tmux: recorre los diseños de paneles predefinidos (columnas, filas, mosaico…) de esta ventana.",
	"ttip.tmux.chooseLayout": "tmux: elige un diseño de paneles concreto de la lista, en vez de ir rotando.",
	"ttip.tmux.zoom":
		"tmux: maximiza temporalmente el panel activo a toda la ventana. Pulsa otra vez para restaurar el diseño — no se cierra nada.",
	"ttip.tmux.closePane":
		"tmux: cierra un panel y termina lo que corre dentro. Primero se abre un selector, así eliges exactamente qué panel muere.",

	// Git bar
	"ttip.git.changeRef": "Cambiar rama de comparación",
	"ttip.git.refDropdown":
		"Elige contra qué rama se comparan el diff y los contadores ahead/behind — normalmente la rama base donde harás merge.",
	"ttip.git.rebase": "Reaplica los commits de la tarea sobre la rama base más reciente. El diff se mantiene honesto y los conflictos aparecen antes.",
	"ttip.git.push": "Publica la rama de la tarea en el remoto. El primer push crea la rama remota.",
	"ttip.git.createPR": "Abre un pull request desde la rama de esta tarea. La insignia de la tarjeta seguirá su CI y su revisión.",
	"ttip.git.autoMerge": "GitHub fusiona el pull request automáticamente en cuanto pasan las comprobaciones y llegan las revisiones requeridas.",
	"ttip.git.merge": "Fusiona la rama de esta tarea en la rama base.",
	"ttip.git.refresh": "Vuelve a comprobar la rama ahora mismo: ahead/behind, PR, CI y estado de revisión.",

	// Open in / files
	"ttip.openIn.menu": "Abre el worktree de esta tarea en tu editor, terminal, gestor de archivos o en GitHub.",
	"ttip.openIn.fileBrowser": "Explora los archivos del worktree en un gestor de archivos de terminal (yazi), en un panel junto al agente.",

	// Scripts / dev server / ports / images
	"ttip.scripts.run": "Ejecuta un script del package.json de este worktree en un panel tmux — ves la salida en vivo.",
	"ttip.devServer":
		"Arranca el dev script del proyecto en su propia ventana tmux, en los puertos asignados a esta tarea — las tareas paralelas nunca pelean por un puerto.",
	"ttip.sharedImages": "Capturas, imágenes de QA y diagramas que el agente compartió contigo en esta tarea. Clic para verlos.",
	"ttip.ports.copyUrl": "Copia la URL pública del túnel para este puerto — compártela o ábrela en otro dispositivo.",
	"ttip.ports.section": "Puertos que escucha esta tarea: ábrelos en el navegador o expónlos a través del túnel remoto.",
};
