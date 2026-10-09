# npm run ytdlp:update
#
# Installs, or updates, the unpacked Windows build of yt-dlp (yt-dlp_win.zip from its GitHub
# release) into %LOCALAPPDATA%\Programs\yt-dlp, and puts that folder first on your PATH.
# The one-file yt-dlp.exe that winget installs unpacks itself at every start, which takes
# 15 to 30 seconds on a slow computer; the unpacked build starts in about a second, which is
# the difference between a song in a few seconds and a song in forty. The download is
# checked against the release's SHA2-256SUMS before anything is replaced. Run it again
# whenever /play keeps failing: YouTube changes often, and yt-dlp follows.

$ErrorActionPreference = 'Stop'

$Dest = Join-Path $env:LOCALAPPDATA 'Programs\yt-dlp'
$Api = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'
$Headers = @{ 'User-Agent' = 'AgentZero (ZeroCorps Discord bot)'; 'Accept' = 'application/vnd.github+json' }

$release = Invoke-RestMethod -Uri $Api -Headers $Headers
$tag = $release.tag_name
$zip = $release.assets | Where-Object { $_.name -eq 'yt-dlp_win.zip' } | Select-Object -First 1
$sums = $release.assets | Where-Object { $_.name -eq 'SHA2-256SUMS' } | Select-Object -First 1
if (-not $zip -or -not $sums) { throw "the latest yt-dlp release ($tag) has no yt-dlp_win.zip or no checksum file" }

$installed = Join-Path $Dest 'yt-dlp.exe'
$current = if (Test-Path $installed) { & $installed --version 2>$null | Select-Object -First 1 } else { $null }
if ($current -eq $tag) {
  Write-Host "yt-dlp $tag is already installed in $Dest."
} else {
  $work = Join-Path $env:TEMP ('yt-dlp-update-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $work | Out-Null
  try {
    Write-Host "Downloading yt-dlp $tag..."
    $zipFile = Join-Path $work 'yt-dlp_win.zip'
    Invoke-WebRequest -Uri $zip.browser_download_url -Headers $Headers -OutFile $zipFile
    $sumsFile = Join-Path $work 'SHA2-256SUMS'
    Invoke-WebRequest -Uri $sums.browser_download_url -Headers $Headers -OutFile $sumsFile

    $line = Get-Content $sumsFile | Where-Object { $_ -match 'yt-dlp_win\.zip' } | Select-Object -First 1
    $expected = if ($line) { ($line -split '\s+')[0] } else { '' }
    $actual = (Get-FileHash -Algorithm SHA256 $zipFile).Hash
    if (-not $expected -or $expected.ToLower() -ne $actual.ToLower()) {
      throw 'the download does not match its published checksum; nothing was changed'
    }

    $unpacked = Join-Path $work 'unpacked'
    Expand-Archive -Path $zipFile -DestinationPath $unpacked -Force
    if (-not (Test-Path (Join-Path $unpacked 'yt-dlp.exe'))) { throw 'the archive holds no yt-dlp.exe; nothing was changed' }

    if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
    New-Item -ItemType Directory -Path (Split-Path $Dest) -Force | Out-Null
    Move-Item -Path $unpacked -Destination $Dest
    Write-Host "Installed yt-dlp $tag in $Dest."
  } finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  }
}

# First on the PATH, ahead of any one-file yt-dlp.exe, so "yt-dlp" means this one.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries = @($userPath -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ne $Dest.TrimEnd('\') })
[Environment]::SetEnvironmentVariable('Path', (@($Dest) + $entries) -join ';', 'User')
Write-Host "$Dest is first on your PATH. New terminals see it at once; a running bot after a restart (npm run autostart -- stop, then start)."
