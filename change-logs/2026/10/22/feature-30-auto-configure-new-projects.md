Short: Auto-configure projects when you add them

The Add Project dialog has an optional Auto-configure switch that reads a new project's lockfiles and package.json and saves the install and dev commands it finds to `.dev3/config.local.json`, so the first task starts with dependencies installed. It is off by default, remembers your choice, never touches a project that is already configured, and shows a toast naming what it saved.
