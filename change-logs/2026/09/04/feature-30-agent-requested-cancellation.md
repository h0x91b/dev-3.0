Short: Agents can ask to cancel a task

An agent can now clean up a task it should not have created: `dev3 task move --status cancelled` asks the user for approval instead of being refused outright. The dialog is deliberately unmistakable — red border, red badge, red button, Cancel focused by default — and it streams the local git check in, keeping the confirm button unavailable until it can tell you what would be lost. Declining exits 22 and leaves the task and its session exactly as they were.
