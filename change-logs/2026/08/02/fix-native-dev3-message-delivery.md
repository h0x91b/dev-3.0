Short: Messages reach native-terminal agents

`dev3 message`, scheduled "Send later" messages, and the Create-PR / commit /
rebase-conflict hand-offs now reach agents running on the native terminal
backend instead of always failing with "the task has no live agent session".
Delivery routes through one backend-neutral seam that finds the task's real agent
pane — never a shell split — and, when another app instance holds that pane's
write lease, hands the whole delivery to it so the text lands exactly once. tmux
behavior is unchanged, and a task with no live agent still fails honestly.
