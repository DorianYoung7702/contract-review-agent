[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$projectRoot = 'D:\Contract_agent'
$backendDir = Join-Path $projectRoot 'backend'
$logDir = Join-Path $projectRoot 'logs'
$serviceLog = Join-Path $logDir 'contract-service-autostart.log'
$backendOutLog = Join-Path $logDir 'backend-autostart.out.log'
$backendErrLog = Join-Path $logDir 'backend-autostart.err.log'
$dockerExe = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
$dockerDesktopExe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
$nodeExe = 'C:\Program Files\nodejs\node.exe'
$requiredContainers = @(
    'contract-agent-postgres',
    'contract-review-onlyoffice',
    'contract-review-frontend'
)

if (-not (Test-Path -LiteralPath $logDir -PathType Container)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

function Write-ServiceLog {
    param([Parameter(Mandatory = $true)][string]$Message)
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -LiteralPath $serviceLog -Value "[$timestamp] $Message" -Encoding utf8
}

function Test-DockerReady {
    & $dockerExe info *> $null
    return $LASTEXITCODE -eq 0
}

function Wait-TcpPort {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [int]$TimeoutSeconds = 90
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $client = [System.Net.Sockets.TcpClient]::new()
        try {
            $connect = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
            if ($connect.AsyncWaitHandle.WaitOne(1000, $false) -and $client.Connected) {
                $client.EndConnect($connect)
                return $true
            }
        } catch {
            # The dependency is still starting; retry until the deadline.
        } finally {
            $client.Dispose()
        }
        Start-Sleep -Seconds 2
    }
    return $false
}

Write-ServiceLog 'Contract service watchdog starting.'

if (-not (Test-Path -LiteralPath $dockerExe -PathType Leaf)) {
    Write-ServiceLog "Docker CLI not found: $dockerExe"
    exit 1
}
if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) {
    Write-ServiceLog "Node.js not found: $nodeExe"
    exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path $backendDir 'index.js') -PathType Leaf)) {
    Write-ServiceLog "Backend entrypoint not found: $backendDir\index.js"
    exit 1
}

if (-not (Test-DockerReady)) {
    if (Test-Path -LiteralPath $dockerDesktopExe -PathType Leaf) {
        Write-ServiceLog 'Docker is not ready; launching Docker Desktop.'
        Start-Process -FilePath $dockerDesktopExe -WindowStyle Hidden
    }

    $dockerDeadline = (Get-Date).AddMinutes(5)
    while ((Get-Date) -lt $dockerDeadline -and -not (Test-DockerReady)) {
        Start-Sleep -Seconds 5
    }
}

if (-not (Test-DockerReady)) {
    Write-ServiceLog 'Docker did not become ready within five minutes.'
    exit 1
}

foreach ($containerName in $requiredContainers) {
    & $dockerExe inspect $containerName *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-ServiceLog "Required container is missing: $containerName"
        exit 1
    }

    $isRunning = (& $dockerExe inspect $containerName --format '{{.State.Running}}').Trim()
    if ($isRunning -ne 'true') {
        Write-ServiceLog "Starting container: $containerName"
        & $dockerExe start $containerName *> $null
        if ($LASTEXITCODE -ne 0) {
            Write-ServiceLog "Failed to start container: $containerName"
            exit 1
        }
    }
}

if (-not (Wait-TcpPort -Port 5434 -TimeoutSeconds 120)) {
    Write-ServiceLog 'PostgreSQL port 5434 did not become ready.'
    exit 1
}

Write-ServiceLog 'Docker dependencies are ready; monitoring backend port 3001.'

while ($true) {
    if (Wait-TcpPort -Port 3001 -TimeoutSeconds 1) {
        Start-Sleep -Seconds 10
        continue
    }

    Write-ServiceLog 'Backend port 3001 is down; starting Node backend.'
    try {
        $startParameters = @{
            FilePath = $nodeExe
            ArgumentList = 'index.js'
            WorkingDirectory = $backendDir
            RedirectStandardOutput = $backendOutLog
            RedirectStandardError = $backendErrLog
            WindowStyle = 'Hidden'
            PassThru = $true
            Wait = $true
        }
        $backendProcess = Start-Process @startParameters
        $backendExitCode = $backendProcess.ExitCode
        Write-ServiceLog "Node backend exited with code $backendExitCode; retrying in five seconds."
    } catch {
        Write-ServiceLog "Node backend start failed: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds 5
}
