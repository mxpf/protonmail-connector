param([string]$Python,[switch]$VerifyLatest)
$ErrorActionPreference='Stop'
$repository=Split-Path -Parent $PSScriptRoot
$private=Join-Path $env:LOCALAPPDATA 'ProtonConnector\private'
$identity=Join-Path $private 'backup-identity.txt'
$backups=Join-Path $private 'backups'
$ageDirectory=Join-Path $env:LOCALAPPDATA 'ProtonConnector\tools\age'
$node=(Get-Command node.exe -ErrorAction Stop).Source
if(!$Python) {
    $runtime=Get-AppxPackage -Name 'OpenAI.CodexPrimaryRuntime*' | Sort-Object Version -Descending | Select-Object -First 1
    if($runtime){$Python=Join-Path $runtime.InstallLocation 'dependencies\python\python.exe'}
}
if(!$Python -or !(Test-Path -LiteralPath $Python -PathType Leaf)){throw 'A Python 3.12 or newer executable is required.'}
if(!(Test-Path -LiteralPath $identity -PathType Leaf)){throw 'The private MITRA backup identity is missing.'}
if(!(Test-Path -LiteralPath (Join-Path $ageDirectory 'age.exe') -PathType Leaf)){throw 'The verified age executable is missing.'}
$lock=[Threading.Mutex]::new($false,'Local\ProtonConnectorEncryptedBackup')
$held=$lock.WaitOne(0)
if(!$held){$lock.Dispose();throw 'A Proton backup or restore check is already running.'}
$originalPath=$env:PATH
try {
    $env:PATH=$ageDirectory+';'+(Split-Path -Parent $node)+';'+$env:PATH
    Push-Location $repository
    try {
        if($VerifyLatest) {
            $latest=Get-ChildItem -LiteralPath $backups -File -Filter '*.age.json' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if(!$latest){throw 'No verified backup download receipt exists.'}
            $receipt=Get-Content -Raw -LiteralPath $latest.FullName | ConvertFrom-Json
        } else {
            $download=& $node scripts/backup-hosted.mjs $backups
            if($LASTEXITCODE -ne 0){throw 'Encrypted backup download failed.'}
            $receipt=($download -join "`n") | ConvertFrom-Json
        }
        $artifact=[IO.Path]::GetFullPath($receipt.path)
        $allowed=[IO.Path]::GetFullPath($backups)+[IO.Path]::DirectorySeparatorChar
        if(!$artifact.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase) -or !$receipt.offServerVerified){throw 'Backup identity or destination did not verify.'}
        if((Get-Item -LiteralPath $artifact).Length -ne $receipt.bytes -or (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash -ine $receipt.sha256){throw 'The encrypted artifact differs from its original download receipt.'}
        $restored=& $Python -B scripts/restore-check.py $artifact $identity
        if($LASTEXITCODE -ne 0){throw 'The downloaded backup failed isolated restore validation.'}
        $validation=($restored -join "`n") | ConvertFrom-Json
        if(!$validation.authenticatedDecryption -or $validation.validationVersion -ne 2 -or $validation.archiveSha256 -ne $receipt.sha256 -or $validation.archiveBytes -ne $receipt.bytes){throw 'Restore evidence did not match the downloaded backup.'}
        [ordered]@{healthy=$true;encryptedBackupVerified=$true;restoreVerified=$true;checkedAt=$validation.checkedAt;archiveBytes=$receipt.bytes;archiveSha256=$receipt.sha256;liveServiceFailoverTested=$false} | ConvertTo-Json -Compress
    } finally {Pop-Location}
} finally {
    $env:PATH=$originalPath
    if($held){$lock.ReleaseMutex()}
    $lock.Dispose()
}
