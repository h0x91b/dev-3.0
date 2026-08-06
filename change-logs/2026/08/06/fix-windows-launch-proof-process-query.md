Short: Windows build survives a stalled process query

A single 60s stall of the Windows launch proof's PowerShell process query withheld the
downloadable Windows build from a launch that had actually succeeded (run 31098005022
attempt 1). The two queries that need parent pids now retry a bounded number of times at
unchanged budgets and record how long every attempt took, and the shutdown liveness polls
moved off PowerShell and WMI onto tasklist.exe, which cuts the number of stall-prone calls
per run from roughly fifteen to two.
