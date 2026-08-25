Short: Setup-failure notice stops lying

The "Setup failed" popup used to claim the agent was never started and offer to start it anyway — but in the default parallel launch mode the agent is already running, and that button destroyed it along with its context. The notice now knows which happened: a live agent gets a small dismissible strip offering to re-run setup, a never-started agent keeps the dialog with the re-run leading. Dismissing it sticks instead of returning on the next task switch, and "Re-run project setup" is also available from the Scripts dropdown.
