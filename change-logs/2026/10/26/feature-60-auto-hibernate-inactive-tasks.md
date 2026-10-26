Short: Hibernate inactive tasks automatically

Settings → Tasks & Board can now automatically hibernate waiting tasks after a chosen period without user interaction, agent hooks, or terminal output. The policy is off by default and protects working tasks, custom columns, and tasks with Keep alive enabled; files and conversations survive, while terminal scrollback is cleared. Dev-server tests now use a single complete environment-store mock so their behavior is consistent across platforms.
