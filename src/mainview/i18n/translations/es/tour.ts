/** Texto del recorrido guiado. Una tarjeta a la vez: el título nombra el control,
 *  el cuerpo dice qué pasa al pulsarlo. Ver `mainview/tour.ts`. */
const tour = {
	"tour.next": "Siguiente",
	"tour.doIt": "Pulsarlo",
	"tour.waiting": "Tu turno: elige algo arriba y yo sigo.",
	"tour.restart": "Empezar de nuevo",
	"tour.exit": "Salir del recorrido",
	"tour.lost.title": "Perdí el hilo",
	"tour.lost.body": "La pantalla a la que apuntaba este paso ya no está. Empieza el recorrido otra vez, o sal y explora por tu cuenta.",
	"tour.back": "Atrás",
	"tour.finish": "Listo",
	"tour.skip": "Prefiero mirar por mi cuenta",

	"tour.firstTask.title": "Tu primera tarea, de principio a fin",
	"tour.firstTask.newTask.title": "Todo empieza en Nueva tarea",
	"tour.firstTask.newTask.body":
		"Toda tarea empieza aquí. Púlsalo y dev-3.0 escribirá el texto por ti: en este repositorio hay un error real que encontrar.",
	"tour.firstTask.prompt.title": "Esto es lo que se le pide al agente",
	"tour.firstTask.prompt.body":
		"El texto ya está escrito: prices.js suma un carrito y redondea mal el total. Todo lo demás de este formulario es opcional.",
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
	"tour.firstTask.review.title": "Léelo antes de quedártelo",
	"tour.firstTask.review.body":
		"Esta fila muestra la rama y lo que cambió en ella. Abre el diff y fusiona solo cuando te guste lo que ves. Ese es todo el ciclo.",
} as const;

export default tour;
