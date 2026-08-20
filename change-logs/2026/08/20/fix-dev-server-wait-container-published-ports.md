Short: Dev-server --wait works with containers

`dev3 dev-server start --wait` now succeeds for projects whose dev server runs in a container: a port that starts listening after the dev server launched counts as ready even when the listening socket belongs to the container runtime's daemon instead of the dev pane's process tree. `restart --wait` counts it too, so a container that keeps running across a stop no longer reads as somebody else squatting the port. Such ports are shown as `Published Ports` in `dev-server status` and in the task's port list instead of being reported as a port conflict, and a wait that does time out now names the process squatting the assigned port.

Suggested by @diverru (h0x91b/dev-3.0#1427)
