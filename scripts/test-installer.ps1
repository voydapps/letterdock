# Installer self-test (runs on the GitHub Windows runner, never on a dev machine with Smart App Control).
# 1) silent install; 2) break the old uninstaller; 3) silent install again (as an update would);
# 4) assert it succeeded, the app files were replaced, the uninstall entry still exists, and the mailto: and
# .eml registration is written (.eml must NOT become the default); 5) run the uninstaller and assert the
# registration is gone.
param([string]$ReleaseDir = 'release')
$ErrorActionPreference = 'Stop'

$setup = Get-ChildItem -Path $ReleaseDir -Filter 'Letterdock-Setup-*.exe' | Select-Object -First 1
if (-not $setup) { throw "No Letterdock-Setup-*.exe in $ReleaseDir" }
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\letterdock'
$exe = Join-Path $installDir 'Letterdock.exe'
$uninstaller = Join-Path $installDir 'Uninstall Letterdock.exe'
$regKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'

function Stop-App {
  Get-Process -Name 'Letterdock' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}
function Install-Silent {
  $p = Start-Process -FilePath $setup.FullName -ArgumentList '/S' -Wait -PassThru
  Stop-App   # the installer starts the app after install
  return $p.ExitCode
}
function Find-UninstallEntry {
  Get-ChildItem $regKey | ForEach-Object { Get-ItemProperty $_.PSPath } |
    Where-Object { $_.DisplayName -like 'Letterdock*' } | Select-Object -First 1
}

Write-Host '== Step 1: fresh silent install'
$code = Install-Silent
if ($code -ne 0) { throw "First install exited with $code" }
foreach ($f in @($exe, $uninstaller)) { if (-not (Test-Path $f)) { throw "Missing after first install: $f" } }

Write-Host '== Step 2: break the old uninstaller and mark the old exe'
# A real program that starts fine but exits with code 5: this is the path where the stock template
# shows an error and quits. (A file that cannot start at all is also handled, but is the easy case.)
$tmp = Join-Path $(if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }) 'fake-uninstaller'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
Set-Content -Path (Join-Path $tmp 'f.cs') -Encoding ascii -Value 'class P { static int Main() { return 5; } }'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo "/out:$tmp\f.exe" "$tmp\f.cs"
if ($LASTEXITCODE -ne 0) { throw 'Could not build the fake uninstaller' }
Copy-Item -Path "$tmp\f.exe" -Destination $uninstaller -Force
$fakeLen = (Get-Item $uninstaller).Length
$marker = [byte[]](1, 2, 3, 4)
[IO.File]::WriteAllBytes($exe, $marker)   # a stale/damaged exe: must be replaced by the update
$staleLen = (Get-Item $exe).Length

Write-Host '== Step 3: silent install over the broken install'
$code = Install-Silent
if ($code -ne 0) { throw "Update install exited with $code (expected 0)" }

Write-Host '== Step 4: assertions'
if (-not (Test-Path $exe)) { throw 'Letterdock.exe missing after update' }
if ((Get-Item $exe).Length -le $staleLen) { throw 'Letterdock.exe was not replaced by the update' }
if ((Get-Item $uninstaller).Length -eq $fakeLen) { throw 'Uninstaller was not rewritten by the new installer' }
$entry = Find-UninstallEntry
if (-not $entry) { throw 'Uninstall registry entry missing' }
if ($entry.UninstallString -notlike '*Uninstall Letterdock.exe*') { throw "Unexpected UninstallString: $($entry.UninstallString)" }
if (-not (Test-Path 'HKCU:\Software\Classes\Letterdock.Url.mailto')) { throw 'mailto registration missing' }

function Get-RegValueOrNull([string]$Path, [string]$Name) {
  $item = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
  if (-not $item) { return $null }
  return $item.GetValue($Name, $null)
}
function Assert-EmlRegistered {
  if (-not (Test-Path 'HKCU:\Software\Classes\Letterdock.eml')) { throw '.eml ProgID missing' }
  if ((Get-RegValueOrNull 'HKCU:\Software\Classes\Letterdock.eml' '') -ne 'Email message') { throw '.eml ProgID name wrong' }
  if ((Get-RegValueOrNull 'HKCU:\Software\Classes\Letterdock.eml\DefaultIcon' '') -notlike '*Letterdock.exe,0') { throw '.eml DefaultIcon wrong' }
  $cmd = Get-RegValueOrNull 'HKCU:\Software\Classes\Letterdock.eml\shell\open\command' ''
  if ($cmd -notlike '"*Letterdock.exe" "%1"') { throw ".eml open command wrong: $cmd" }
  if ((Get-RegValueOrNull 'HKCU:\Software\Letterdock\Capabilities\FileAssociations' '.eml') -ne 'Letterdock.eml') { throw '.eml capability entry missing' }
  $open = Get-Item -LiteralPath 'HKCU:\Software\Classes\.eml\OpenWithProgids' -ErrorAction SilentlyContinue
  if (-not $open -or $open.GetValueNames() -notcontains 'Letterdock.eml') { throw 'Letterdock.eml missing in .eml OpenWithProgids' }
}
function Assert-EmlDefaultNotTaken {
  # The default app for .eml is the user's choice: we must never write it.
  if ((Get-RegValueOrNull 'HKCU:\Software\Classes\.eml' '') -eq 'Letterdock.eml') { throw 'Letterdock took over the .eml default value' }
  $choice = Get-RegValueOrNull 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.eml\UserChoice' 'ProgId'
  if ($choice -eq 'Letterdock.eml') { throw 'Letterdock is the UserChoice for .eml (the installer must never do that)' }
}
Assert-EmlRegistered
Assert-EmlDefaultNotTaken

Write-Host '== Step 5: uninstall removes the registration'
# _?= makes the NSIS uninstaller run in place, so -Wait really waits for it.
$u = Start-Process -FilePath $uninstaller -ArgumentList "/S _?=$installDir" -Wait -PassThru
if ($u.ExitCode -ne 0) { throw "Uninstaller exited with $($u.ExitCode)" }
Stop-App
if (Test-Path 'HKCU:\Software\Classes\Letterdock.eml') { throw '.eml ProgID still there after uninstall' }
if ($null -ne (Get-RegValueOrNull 'HKCU:\Software\Letterdock\Capabilities\FileAssociations' '.eml')) { throw '.eml capability entry still there after uninstall' }
$open = Get-Item -LiteralPath 'HKCU:\Software\Classes\.eml\OpenWithProgids' -ErrorAction SilentlyContinue
if ($open -and $open.GetValueNames() -contains 'Letterdock.eml') { throw 'Letterdock.eml still in .eml OpenWithProgids after uninstall' }
if (Test-Path 'HKCU:\Software\Classes\Letterdock.Url.mailto') { throw 'mailto ProgID still there after uninstall' }
Assert-EmlDefaultNotTaken
Write-Host 'Installer self-test passed.'
