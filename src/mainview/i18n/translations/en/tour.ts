/** Guided-tour copy. One card at a time: the title names the control, the body
 *  says what pressing it does. See `mainview/tour.ts`. */
const tour = {
	"tour.next": "Next",
	"tour.doIt": "Do it",
	"tour.waiting": "Your turn — pick something above and I'll follow along.",
	"tour.pending": "Waiting for the agent. This takes as long as the work does.",
	"tour.exit": "Leave the walkthrough",
	"tour.lost.title": "I lost the thread",
	"tour.lost.body": "Nothing this walkthrough was pointing at is on screen any more. Leave it — you can start it again from Explain this screen whenever you like.",
	"tour.back": "Back",
	"tour.finish": "Done",
	"tour.skip": "I'll look around myself",

	"tour.firstTask.title": "Your first task, start to finish",
	"tour.firstTask.newTask.title": "Start with New Task",
	"tour.firstTask.newTask.body":
		"Every task starts here. Press it and dev-3.0 fills in the prompt for you — a small, visible change to make in this repo.",
	"tour.firstTask.prompt.title": "This is what the agent is told",
	"tour.firstTask.prompt.body":
		"The prompt is already written: this repo serves one page with one green button, and the agent is asked to turn it blue and show you the before and after. Everything else on this form is optional.",
	"tour.firstTask.start.title": "Save parks it, Save & Start runs it",
	"tour.firstTask.start.body":
		"The blue button only saves the task to the board. The green one also gives it a branch of its own and starts an agent on it.",
	"tour.firstTask.launch.title": "Who does the work",
	"tour.firstTask.launch.body":
		"Pick an agent and how much freedom it gets. Add a second row and two agents solve the same task separately, so you can compare and keep one. Press Launch at the bottom when you are happy. In the sandbox it starts in a mode that never stops to ask permission — this is a lesson, not your repository.",
	"tour.firstTask.openTask.title": "Open it",
	"tour.firstTask.openTask.body":
		"The task left To Do and already has its own branch — it may be working, or already asking you something. Click the card to watch it; launching does not take you there on its own, so a whole board of agents stays one screen.",
	"tour.firstTask.terminal.title": "The agent works here",
	"tour.firstTask.terminal.body":
		"A real terminal in a copy of the repository that only this task owns. You can type into it — it is a conversation, not a progress bar.",
	"tour.firstTask.devServer.title": "Run the page while it works",
	"tour.firstTask.devServer.body":
		"This starts the sandbox's own server on a port dev-3.0 keeps for this task, so you can open the page in a browser and watch it change. Press play, then come back here.",
	"tour.firstTask.artifact.title": "The agent's own report",
	"tour.firstTask.artifact.body":
		"Agents can publish a page of their own — here it is, with the button before and after. It stays with the task, so you can reopen it later.",
	"tour.firstTask.review.title": "Read it before you keep it",
	"tour.firstTask.review.body":
		"This row shows the branch and what changed on it. Open the diff, and merge only once you like what you see.",
	"tour.firstTask.merge.title": "Keep the change",
	"tour.firstTask.merge.body":
		"Merge puts the branch back into main. In your own repos this is the moment you decide the work was worth keeping. Merge lights up once the agent has committed its work — until then this button is greyed out.",
	"tour.firstTask.complete.title": "And that closes it",
	"tour.firstTask.complete.body":
		"dev-3.0 saw the merge and asks whether the task is done. Press Complete task — the copy of the repo it worked in is cleaned up, and the board is clear. That is the whole loop.",
} as const;

export default tour;
