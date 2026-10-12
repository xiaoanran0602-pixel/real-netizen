# Lin 管理脚本（Windows PowerShell 5.1+）。只需要装好 Node 22+。
#   .\lin.ps1 -Watch      守护：启动服务，崩了 10 秒后拉起；探活连续失败也会重启；输出写到 data\logs
#   .\lin.ps1 -Install    注册计划任务「Lin」（登录时以 -Watch 启动）并立即启动
#   .\lin.ps1 -Uninstall  删除计划任务并停止
#   .\lin.ps1 -Stop       停止（先写 stop 标记，守护不会再拉起）
#   .\lin.ps1 -Restart    重启服务（守护在跑就只重启服务进程，否则后台启动守护）
#   .\lin.ps1 -Open       带令牌在浏览器里打开
#   .\lin.ps1 -Pack       打包成 zip（排除 data\secrets、data\logs），默认放在 Lin 的上一级目录；-Out 指定路径
# 可选：-Port 3030  -Data <数据目录>
param(
  [switch]$Watch, [switch]$Install, [switch]$Uninstall, [switch]$Stop, [switch]$Restart, [switch]$Open, [switch]$Pack,
  [int]$Port = 3030,
  [string]$Data = "",
  [string]$Out = ""
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$taskName = "Lin"
$dataDir = if ($Data) { [IO.Path]::GetFullPath($Data) } else { Join-Path $root "data" }
$logDir = Join-Path $dataDir "logs"
$stopFlag = Join-Path $dataDir "stop.flag"
$mainScript = Join-Path $root "src\main.js"
$baseUrl = "http://127.0.0.1:$Port"
$restartDelaySeconds = 10
$probeIntervalSeconds = 30
$probeFailuresBeforeKill = 3

function Write-WatchLog([string]$text) {
  New-Item -ItemType Directory -Force $logDir | Out-Null
  Add-Content -Encoding UTF8 (Join-Path $logDir "watchdog.log") "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $text"
}

function Get-NodePath {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw "找不到 node。请先安装 Node.js 22 或更新版本。" }
  return $node.Source
}

function Get-ServerProcesses {
  $pattern = [regex]::Escape($mainScript)
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match $pattern }
}

function Get-OtherWatchdogs {
  $pattern = [regex]::Escape((Join-Path $root "lin.ps1"))
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" |
    Where-Object { $_.CommandLine -match $pattern -and $_.CommandLine -match '-Watch' -and $_.ProcessId -ne $PID }
}

function Stop-Server {
  Get-ServerProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Test-Server {
  try {
    $null = Invoke-WebRequest "$baseUrl/" -UseBasicParsing -TimeoutSec 5
    return $true
  } catch {
    return $false
  }
}

function Get-Token {
  $file = Join-Path $dataDir "secrets\access-token.txt"
  if (Test-Path $file) { return (Get-Content $file -Raw).Trim() }
  return ""
}

function Start-WatchInBackground {
  $watchArgs = @("-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", "`"$(Join-Path $root 'lin.ps1')`"", "-Watch", "-Port", "$Port")
  if ($Data) { $watchArgs += @("-Data", "`"$dataDir`"") }
  Start-Process powershell -WindowStyle Hidden -ArgumentList $watchArgs | Out-Null
}

if ($Stop -or $Uninstall) {
  New-Item -ItemType Directory -Force $dataDir | Out-Null
  # 先让守护知道是主动停止，避免它马上又拉起来。
  New-Item -ItemType File -Force $stopFlag | Out-Null
  Get-OtherWatchdogs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Stop-Server
  if ($Uninstall -and (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output "已删除计划任务「$taskName」。"
  }
  Write-Output "Lin 已停止。"
  exit 0
}

if ($Install) {
  $null = Get-NodePath
  $argument = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $root 'lin.ps1')`" -Watch -Port $Port"
  if ($Data) { $argument += " -Data `"$dataDir`"" }
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argument -WorkingDirectory $root
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "Lin：和她聊天的私人软件（登录时启动守护）" -Force | Out-Null
  Remove-Item $stopFlag -ErrorAction SilentlyContinue
  Start-ScheduledTask -TaskName $taskName
  Write-Output "已注册并启动计划任务「$taskName」（端口 $Port）。打开网页：.\lin.ps1 -Open"
  exit 0
}

if ($Restart) {
  Remove-Item $stopFlag -ErrorAction SilentlyContinue
  if (Get-OtherWatchdogs) {
    # 守护在跑：只停服务进程，守护 10 秒内拉起。
    Stop-Server
    Write-Output "已重启（守护会在 $restartDelaySeconds 秒内拉起服务）。"
  } else {
    Stop-Server
    Start-WatchInBackground
    Write-Output "已在后台启动守护。"
  }
  exit 0
}

if ($Open) {
  $token = Get-Token
  $query = if ($token) { "?token=$([uri]::EscapeDataString($token))" } else { "" }
  Start-Process "$baseUrl/$query"
  exit 0
}

if ($Pack) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmm"
  $target = if ($Out) { [IO.Path]::GetFullPath($Out) } else { Join-Path (Split-Path $root -Parent) "Lin-$stamp.zip" }
  $staging = Join-Path ([IO.Path]::GetTempPath()) "lin-pack-$stamp"
  Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
  $dest = Join-Path $staging "Lin"
  # robocopy 退出码 < 8 都算成功。排除密钥、日志、守护标记、版本库与临时脚本。
  robocopy $root $dest /E /NFL /NDL /NJH /NJS /NP /XD (Join-Path $root "data\secrets") (Join-Path $root "data\logs") (Join-Path $root ".git") (Join-Path $root "test\scratch") /XF "stop.flag" | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "复制失败（robocopy $LASTEXITCODE）" }
  if (Test-Path $target) { Remove-Item -Force $target }
  Compress-Archive -Path $dest -DestinationPath $target
  Remove-Item -Recurse -Force $staging
  Write-Output "已打包：$target（不含 data\secrets 和 data\logs；到新电脑上要重新填模型 Key 和聊天渠道凭据）"
  exit 0
}

if ($Watch) {
  if (Get-OtherWatchdogs) { exit 0 }
  New-Item -ItemType Directory -Force $logDir | Out-Null
  Remove-Item $stopFlag -ErrorAction SilentlyContinue
  $node = Get-NodePath
  $nodeArgs = @("`"$mainScript`"", "--port", "$Port")
  if ($Data) { $nodeArgs += @("--data", "`"$dataDir`"") }
  while (-not (Test-Path $stopFlag)) {
    Stop-Server
    $serverLog = Join-Path $logDir "server.log"
    $errorLog = Join-Path $logDir "server.err.log"
    # 上一次的输出留一份，方便看崩溃前发生了什么。
    if (Test-Path $serverLog) { Move-Item -Force $serverLog (Join-Path $logDir "server.prev.log") }
    if (Test-Path $errorLog) { Move-Item -Force $errorLog (Join-Path $logDir "server.err.prev.log") }
    Write-WatchLog "start server"
    # 修复依据：Windows PowerShell 5.1 在 ErrorActionPreference=Stop 下会把子进程写到 stderr 的日志当成终止错误，
    # 守护自己就退出了。用 Start-Process 把输出直接写文件，不经过 PowerShell 的错误流。
    $proc = Start-Process $node -ArgumentList $nodeArgs -WorkingDirectory $root -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $serverLog -RedirectStandardError $errorLog
    $failures = 0
    while (-not $proc.HasExited -and -not (Test-Path $stopFlag)) {
      # 修复：原来先睡满探活间隔再看进程，崩溃后要等 30 秒才发现；WaitForExit 在进程退出时立即返回。
      if ($proc.WaitForExit($probeIntervalSeconds * 1000)) { break }
      if (Test-Path $stopFlag) { break }
      if (Test-Server) { $failures = 0 } else { $failures += 1 }
      if ($failures -ge $probeFailuresBeforeKill) {
        Write-WatchLog "server not responding, restarting"
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        break
      }
    }
    if (Test-Path $stopFlag) { break }
    $proc.WaitForExit(5000) | Out-Null
    Write-WatchLog "server exited $($proc.ExitCode)"
    Start-Sleep -Seconds $restartDelaySeconds
  }
  Stop-Server
  Write-WatchLog "watchdog stopped"
  exit 0
}

Get-Content $PSCommandPath -TotalCount 9 | ForEach-Object { $_ -replace '^# ?', '' }
