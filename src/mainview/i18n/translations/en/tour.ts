/** Guided-tour copy. One card at a time: the title names the control, the body
 *  says what pressing it does. See `mainview/tour.ts`. */
const tour = {
	"tour.next": "Next",
	"tour.back": "Back",
	"tour.finish": "Done",
	"tour.skip": "I'll look around myself",

	"tour.firstTask.title": "Your first task, start to finish",
	"tour.firstTask.newTask.title": "Start here",
	"tour.firstTask.newTask.body":
		"An empty board. Click New Task and dev-3.0 will fill in a prompt for you — there is a real bug in this repo to find.",
	"tour.firstTask.prompt.title": "This is what the agent is told",
	"tour.firstTask.prompt.body":
		"The prompt is already written: prices.js adds up a shopping cart and rounds the total wrong. Everything else on this form is optional.",
	"tour.firstTask.start.title": "Save parks it, Save & Start runs it",
	"tour.firstTask.start.body":
		"The blue button only saves the task to the board. The green one also gives it a branch of its own and starts an agent on it.",
	"tour.firstTask.launch.title": "Who does the work",
	"tour.firstTask.launch.body":
		"Pick an agent and how much freedom it gets. Add a second row and two agents solve the same task separately, so you can compare and keep one.",
	"tour.firstTask.terminal.title": "The agent works here",
	"tour.firstTask.terminal.body":
		"A real terminal in a copy of the repository that only this task owns. You can type into it — it is a conversation, not a progress bar.",
	"tour.firstTask.review.title": "Read it before you keep it",
	"tour.firstTask.review.body":
		"This row shows the branch and what changed on it. Open the diff, and merge only once you like what you see. That is the whole loop.",
} as const;

export default tour;
