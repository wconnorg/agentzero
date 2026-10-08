# npm run autostart -- install | status | log | start | stop | remove
#
# Lets Windows run Agent Zero instead of a terminal. `install` registers a scheduled task
# named "Agent Zero" (Task Scheduler is part of Windows: nothing is installed, and no admin
# rights are needed) that starts the bot, with no window, whenever you sign in to Windows.
# The task runs in your own session, so the bot is offline while the laptop sleeps or nobody
# is signed in; it reconnects by itself when the laptop wakes.
#
# After a crash (the bot ending with an error, which includes failing to reach Discord),
# `run` starts it again two minutes later, up to 90 times in a row, and then gives up: a bot
# that cannot start at all (a bad token, say) must not keep knocking on Discord's door, which
# allows a bot 1000 sign-ins a day. A run of an hour or more resets that count. Task
# Scheduler's own "restart on failure" setting is not used: it only covers the task failing
# to launch, not the bot ending with an error (measured on this laptop, 2026-10-08).
#
# The bot's log goes to %LOCALAPPDATA%\Agent Zero\agent-zero.log. It starts over whenever
# the task starts (at sign-in, or `start`), so it holds the current session only and never
# grows. It holds what a terminal would show: Discord ids, role and channel names, counts
# and errors; never the token or the secret.
#
# `run` is what the task itself executes; the other commands are for you.

param(
  [Parameter(Position = 0)]
  [string] $Command = 'status'
)

$ErrorActionPreference = 'Stop'

$TaskName = 'Agent Zero'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$LogDir = Join-Path $env:LOCALAPPDATA 'Agent Zero'
$LogFile = Join-Path $LogDir 'agent-zero.log'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
# Marks the bot the task started, to tell it from one started with npm start.
$Marker = '--title=AgentZero'
$MaxRestarts = 90
$RestartWaitSeconds = 120

function Get-Task {
  return Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

# Every running copy of the bot: the task's own (FromTask) and any started by hand. npm
# start runs "node --env-file-if-exists=.env src/index.ts"; so does the task, plus the marker.
function Get-Bots {
  $bots = @()
  foreach ($process in Get-CimInstance Win32_Process -Filter "Name='node.exe'") {
    $commandLine = [string] $process.CommandLine
    if ($commandLine -notmatch '--env-file-if-exists=\.env' -or $commandLine -notmatch 'src[\\/]index\.ts') { continue }
    $fromTask = $commandLine -match [regex]::Escape($Marker)
    $bots += [pscustomobject]@{ ProcessId = $process.ProcessId; FromTask = $fromTask }
  }
  return $bots
}

# Always wrap a call in @(): PowerShell 5.1 gives a single object no .Count.
function Get-BotsByHand {
  return Get-Bots | Where-Object { -not $_.FromTask }
}

# What the task's last result means; the numbers are Task Scheduler's own.
function Describe-Result([uint32] $Code) {
  switch ($Code) {
    0 { return 'the bot ended without an error' }
    1 { return 'the bot stopped with an error: see the log' }
    0x41301 { return 'running' }
    0x41302 { return 'the task is disabled' }
    0x41303 { return 'the task has not run yet' }
    0x41306 { return 'stopped by hand' }
    default { return ('ended with code 0x{0:X}: see the log' -f $Code) }
  }
}

function Show-Log([int] $Lines) {
  if (-not (Test-Path $LogFile)) {
    Write-Host "No log yet at $LogFile"
    return
  }
  Write-Host "Last $Lines lines of $LogFile`:"
  Get-Content -Path $LogFile -Encoding UTF8 -Tail $Lines | ForEach-Object { Write-Host "  $_" }
}

function Show-Status {
  $task = Get-Task
  if (-not $task) {
    Write-Host "The Windows task `"$TaskName`" is not installed. Install it with: npm run autostart -- install"
  } else {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "Task:        $TaskName ($($task.State))"
    Write-Host "Last start:  $($info.LastRunTime)"
    Write-Host "Last result: $(Describe-Result $info.LastTaskResult)"
  }
  if (@(Get-BotsByHand).Count -gt 0) {
    Write-Host 'A copy of the bot started by hand (npm start) is running too: stop it with Ctrl+C in its terminal.'
  }
  Show-Log 15
}

function Start-Bot {
  $task = Get-Task
  if (-not $task) {
    Write-Host "The Windows task `"$TaskName`" is not installed. Install it with: npm run autostart -- install"
    return
  }
  if ($task.State -eq 'Running') {
    Write-Host 'Agent Zero is already running.'
    Show-Log 5
    return
  }
  if (@(Get-BotsByHand).Count -gt 0) {
    Write-Host 'The bot is already running in a terminal (npm start): two copies would greet everyone twice.'
    Write-Host 'Stop it there with Ctrl+C, then run: npm run autostart -- start'
    return
  }
  Start-ScheduledTask -TaskName $TaskName
  Write-Host 'Starting Agent Zero; its first lines follow in a moment (signing in can take half a minute).'
  Start-Sleep -Seconds 30
  $task = Get-Task
  if ($task.State -ne 'Running') {
    Write-Host 'Agent Zero ended right after starting. The log may say why; "npm run autostart -- start" tries again.'
  }
  Show-Status
}

# Ends the task's copy of the bot; one started by hand is left alone.
function Stop-Bot {
  $task = Get-Task
  if ($task -and $task.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName }
  # Task Scheduler ends the process it started, taking a moment over it. Then make sure the
  # restart loop and the bot itself went with it, the loop first, or it would start the
  # bot again.
  for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Seconds 1
    $task = Get-Task
    if (-not $task -or $task.State -ne 'Running') { break }
  }
  foreach ($loop in Get-CimInstance Win32_Process -Filter "Name='powershell.exe'") {
    if (([string] $loop.CommandLine) -match 'autostart\.ps1" run') {
      Stop-Process -Id $loop.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
  foreach ($bot in Get-Bots | Where-Object { $_.FromTask }) {
    Stop-Process -Id $bot.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Install-Task {
  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    Write-Host 'node.exe was not found: install Node 24 or later first.'
    return
  }
  Stop-Bot
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $script = Join-Path $PSScriptRoot 'autostart.ps1'
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $Root `
    -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script + '" run')
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
  # Half a minute after signing in, so the network is up before the bot's first try.
  $trigger.Delay = 'PT30S'
  $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
  # No time limit (the default stops a task after three days), and a laptop runs on battery.
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Force | Out-Null
  Write-Host "Registered the Windows task `"$TaskName`": it starts the bot whenever you sign in to Windows, and again after a crash."
  Start-Bot
}

function Remove-Task {
  if (-not (Get-Task)) {
    Write-Host "The Windows task `"$TaskName`" is not installed; nothing to remove."
    return
  }
  Stop-Bot
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed the Windows task `"$TaskName`". The bot now runs only when you start it: npm start"
}

# A line in the log in the bot's own format, for what the loop itself has to say.
function Add-LogLine([string] $Text) {
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  [System.IO.File]::AppendAllText($LogFile, "$stamp $Text`n", $Utf8)
}

# The task's action: the bot, its output in the log file, started again after a crash.
function Invoke-Bot {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  [System.IO.File]::WriteAllText($LogFile, '', $Utf8)
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) {
    Add-LogLine 'ERROR node.exe was not found: install Node 24 or later'
    exit 1
  }
  # cmd does the redirection: PowerShell 5.1 would wrap every stderr line in an error record.
  $line = '/c ""' + $node.Source + '" ' + $Marker + ' --env-file-if-exists=.env src/index.ts >> "' + $LogFile + '" 2>&1"'
  $failures = 0
  while ($true) {
    $startedAt = Get-Date
    $bot = Start-Process -FilePath cmd.exe -ArgumentList $line -WorkingDirectory $Root -NoNewWindow -Wait -PassThru
    $code = $bot.ExitCode
    # Ended on purpose (Ctrl+C, or Discord closing the connection for good is code 1): only an error restarts it.
    if ($code -eq 0) { exit 0 }
    if (((Get-Date) - $startedAt).TotalHours -ge 1) { $failures = 0 }
    $failures++
    if ($failures -gt $MaxRestarts) {
      Add-LogLine "ERROR the bot stopped $MaxRestarts times in a row (last code $code): giving up until the next sign-in, or npm run autostart -- start"
      exit $code
    }
    Add-LogLine "ERROR the bot stopped with code $code; starting it again in $RestartWaitSeconds seconds (try $failures of $MaxRestarts)"
    Start-Sleep -Seconds $RestartWaitSeconds
  }
}

switch ($Command) {
  'install' { Install-Task }
  'remove' { Remove-Task }
  'start' { Start-Bot }
  'stop' {
    Stop-Bot
    Write-Host 'Agent Zero is stopped. It starts again when you next sign in to Windows; "npm run autostart -- remove" stops that too.'
  }
  'status' { Show-Status }
  'log' { Show-Log 40 }
  'run' { Invoke-Bot }
  default {
    Write-Host 'Usage: npm run autostart -- install | status | log | start | stop | remove'
    exit 1
  }
}
