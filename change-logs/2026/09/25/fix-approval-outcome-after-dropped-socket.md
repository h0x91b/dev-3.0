Short: Approval waits survive a dropped connection

`dev3 task move --status completed|cancelled` no longer dies with "Empty response from server" when its connection to the app drops mid-wait: it asks the app where the request stands and re-attaches to a still-pending one without opening a second dialog. A request that timed out while still open now exits 25, and one whose outcome the app can no longer tell (for example after a restart) exits 26 instead of a generic failure.
