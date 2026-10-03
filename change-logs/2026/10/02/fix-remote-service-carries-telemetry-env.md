Short: Service keeps your telemetry opt-out

`dev3 remote install-service` now writes `DEV3_TELEMETRY`, `DO_NOT_TRACK`, `DEV3_HOME` and a few other dev3 settings from your shell into the systemd unit and prints what it carried, so a service installed with telemetry off stays off without a hand-written drop-in.
