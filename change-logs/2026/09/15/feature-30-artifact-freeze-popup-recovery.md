Short: Artifacts reopen in a popup after a freeze

If a window stops responding for 20 seconds with an HTML artifact open, dev3 records it locally and turns the "Open artifacts in a popup" setting on at the next launch, before any artifact reopens, then says so once in a toast that links to the setting. It is association, not a proven cause: a force quit on its own, a hidden window, a remote tab, a machine waking from sleep and a stall with no artifact in it are all deliberately ignored, and turning the popup back off ends the automatic recovery for good.
