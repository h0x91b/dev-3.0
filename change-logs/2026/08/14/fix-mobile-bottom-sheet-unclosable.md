Short: Mobile sheets close again

Fixed the mobile bottom sheets (task actions, status, move to, PR status, pane map) rendering taller than the screen inside a task, which pushed their header — grabber, title and close button — above the top edge and left no backdrop to tap, so the only way out was picking an action. Backdrop dismissal now listens for a pointer tap, which iOS delivers reliably.
