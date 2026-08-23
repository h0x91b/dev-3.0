/** Texto del recorrido guiado. Una tarjeta a la vez: el título nombra el control,
 *  el cuerpo dice qué pasa al pulsarlo. Ver `mainview/tour.ts`. */
const tour = {
	"tour.next": "Siguiente",
	"tour.doIt": "Pulsarlo",
	"tour.waiting": "Tu turno: elige algo arriba y yo sigo.",
	"tour.pending": "Esperando al agente. Tardará lo que tarde el trabajo.",
	"tour.exit": "Salir del recorrido",
	"tour.lost.title": "Perdí el hilo",
	"tour.lost.body": "Ya no queda en pantalla nada de lo que señalaba el recorrido. Sal — puedes volver a empezarlo desde Explicar esta pantalla cuando quieras.",
	"tour.back": "Atrás",
	"tour.finish": "Listo",
	"tour.skip": "Prefiero mirar por mi cuenta",

	"tour.firstTask.title": "Tu primera tarea, de principio a fin",
	"tour.firstTask.newTask.title": "Todo empieza en Nueva tarea",
	"tour.firstTask.newTask.body":
		"Toda tarea empieza aquí. Púlsalo y dev-3.0 escribirá el texto por ti: un cambio pequeño y bien visible en este repositorio.",
	"tour.firstTask.prompt.title": "Esto es lo que se le pide al agente",
	"tour.firstTask.prompt.body":
		"El texto ya está escrito: el repositorio sirve una página con un botón verde, y se le pide al agente que lo ponga azul y te muestre el antes y el después. Todo lo demás de este formulario es opcional.",
	"tour.firstTask.start.title": "Guardar la aparca, Guardar e iniciar la ejecuta",
	"tour.firstTask.start.body":
		"El botón azul solo guarda la tarea en el tablero. El verde además le da su propia rama y arranca un agente sobre ella.",
	"tour.firstTask.launch.title": "Quién hace el trabajo",
	"tour.firstTask.launch.body":
		"Elige un agente y cuánta libertad tiene. Añade una segunda fila y dos agentes resolverán la misma tarea por separado, para comparar y quedarte con una. Pulsa Launch abajo cuando te convenza.",
	"tour.firstTask.openTask.title": "Ábrela",
	"tour.firstTask.openTask.body":
		"La tarea salió de Por hacer y ya tiene su propia rama: puede estar trabajando o ya preguntándote algo. Pulsa la tarjeta para verla; lanzar no te lleva allí por sí solo, así un tablero entero de agentes cabe en una pantalla.",
	"tour.firstTask.terminal.title": "Aquí trabaja el agente",
	"tour.firstTask.terminal.body":
		"Una terminal real en una copia del repositorio que solo pertenece a esta tarea. Puedes escribir en ella: es una conversación, no una barra de progreso.",
	"tour.firstTask.devServer.title": "Levanta la página mientras trabaja",
	"tour.firstTask.devServer.body":
		"Esto arranca el servidor del sandbox en un puerto que dev-3.0 reserva para esta tarea, así puedes abrir la página en el navegador y verla cambiar. Pulsa play y vuelve aquí.",
	"tour.firstTask.artifact.title": "El informe del propio agente",
	"tour.firstTask.artifact.body":
		"Los agentes pueden publicar una página propia: aquí está, con el botón antes y después. Se queda con la tarea, así que puedes reabrirla más tarde.",
	"tour.firstTask.review.title": "Léelo antes de quedártelo",
	"tour.firstTask.review.body":
		"Esta fila muestra la rama y lo que cambió en ella. Abre el diff y fusiona solo cuando te guste lo que ves.",
	"tour.firstTask.merge.title": "Quédate el cambio",
	"tour.firstTask.merge.body":
		"Fusionar devuelve la rama a main. En tus propios repositorios este es el momento en que decides que el trabajo merece quedarse. Fusionar se activa cuando el agente haya hecho commit; hasta entonces el botón está en gris.",
	"tour.firstTask.complete.title": "Y con eso se cierra",
	"tour.firstTask.complete.body":
		"dev-3.0 vio la fusión y pregunta si la tarea está lista. Pulsa Completar tarea: la copia del repositorio donde trabajó se limpia y el tablero queda despejado. Ese es todo el ciclo.",
} as const;

export default tour;
