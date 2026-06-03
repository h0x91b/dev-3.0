Added a prominent "No Sleep" toggle to the global header (amber Awake state, coffee glyph). It keeps your machine awake the whole time dev-3.0 is open — default on — so long-running agents and remote sessions never stall on a sleeping Mac. While remote access is active the toggle is forced on and locked.

This surfaces the previously buried preventSleepWhileRunning setting and changes its meaning from "while agents are running" to "while the app is running". Backed by new getPreventSleepState / setPreventSleep RPCs.

Suggested by @aidanpraidw (h0x91b/dev-3.0#384)
