Short: No false freeze captures after unhiding

Freeze diagnostics no longer treat the first heartbeat of a window that was just hidden as a stalled renderer, so the limited stack captures stay available for real freezes.
