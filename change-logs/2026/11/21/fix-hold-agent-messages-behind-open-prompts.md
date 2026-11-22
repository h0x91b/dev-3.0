Short: Messages wait while an agent asks you

Peer, coordinator and scheduled `dev3 message`s are no longer typed into a Claude agent while it shows a permission menu, a plan approval or an AskUserQuestion picker: they wait, with no time limit, and arrive shortly after you answer. The task card and the open task show "N waiting" with a Send now action for a prompt dev3 missed closing (Esc fires no hook), and `dev3 message` tells the sender the message is held behind a prompt. Restart running Claude sessions to pick up the new permission hook.
