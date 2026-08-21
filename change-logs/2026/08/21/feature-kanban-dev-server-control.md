Short: See dev servers on the board

Kanban cards for active tasks with a dev script now carry a dev-server control: the left half shows the live state (running with its lowest port, starting, stopped, or a red port conflict) and opens that port in the browser, the right half stops the server. Dev-server state is broadcast to the board from the port-scan cycle instead of being polled per task by the info panel.
