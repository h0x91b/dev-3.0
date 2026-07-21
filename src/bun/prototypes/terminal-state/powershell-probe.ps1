$escape = [char]27
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::Write("$escape]0;PowerShell terminal-state probe`a")
[Console]::Write("$escape[2J$escape[H")
Write-Host "$escape[1;38;2;80;160;240mPowerShell $($PSVersionTable.PSVersion)$escape[0m"
Write-Host "wide=界 combining=é emoji=🙂"
1..24 | ForEach-Object {
    Write-Host ("$escape[38;5;{0}mhistory-{1:D2}$escape[0m" -f ($_ + 16), $_)
}
[Console]::Write("$escape[?25l$escape[6 q")
Start-Sleep -Seconds 5
