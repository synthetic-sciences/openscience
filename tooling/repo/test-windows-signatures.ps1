$ErrorActionPreference = 'Stop'
$directory = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
New-Item -ItemType Directory $directory | Out-Null
$verifier = Join-Path $PSScriptRoot 'verify-windows-signatures.ps1'
$certificate = $null

function Assert-Rejected([string]$File, [string]$Publisher, [string]$Reason) {
    $failure = $null
    try { & $verifier -Files $File -Publisher $Publisher }
    catch { $failure = $_.Exception.Message }
    if (-not $failure -or -not $failure.Contains($Reason)) {
        throw "Expected '$Reason' for '$File', got '$failure'"
    }
    Write-Output "Rejected as expected: $Reason"
}

try {
    # Exercise Windows' real Authenticode implementation using the runner's
    # Microsoft-signed PowerShell binary, without access to production keys.
    $binary = (Get-Process -Id $PID).Path
    $signature = Get-AuthenticodeSignature -LiteralPath $binary
    $publisher = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    & $verifier -Files $binary -Publisher $publisher
    Assert-Rejected $binary 'Wrong Publisher Inc.' 'Unexpected publisher'
    Assert-Rejected (Join-Path $directory 'missing.exe') $publisher 'Missing signed file'

    $tampered = Join-Path $directory 'tampered.exe'
    Copy-Item -LiteralPath $binary -Destination $tampered
    $bytes = [System.IO.File]::ReadAllBytes($tampered)
    $bytes[1024] = $bytes[1024] -bxor 1
    [System.IO.File]::WriteAllBytes($tampered, $bytes)
    Assert-Rejected $tampered $publisher 'Invalid Authenticode signature'

    $script = Join-Path $directory 'fixture.ps1'
    Set-Content -LiteralPath $script -Value 'Write-Output fixture'
    Assert-Rejected $script $publisher 'Invalid Authenticode signature'

    # Trust this short-lived test certificate only on the disposable runner
    # so an otherwise valid signature reaches the missing-timestamp check.
    if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
        throw 'The temporary trust fixture requires a disposable GitHub-hosted runner'
    }
    $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=OpenScience Signing Test' -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddDays(1)
    $public = Join-Path $directory 'fixture.cer'
    Export-Certificate -Cert $certificate -FilePath $public | Out-Null
    # CurrentUser\Root opens a confirmation dialog that cannot complete in CI.
    Import-Certificate -FilePath $public -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
    Set-AuthenticodeSignature -LiteralPath $script -Certificate $certificate -HashAlgorithm SHA256 | Out-Null
    Assert-Rejected $script 'OpenScience Signing Test' 'Missing signature timestamp'
    Write-Output 'Windows signature verification checks passed'
}
finally {
    if ($null -ne $certificate) {
        Remove-Item -LiteralPath "Cert:\LocalMachine\Root\$($certificate.Thumbprint)" -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $directory -Recurse -Force
}
