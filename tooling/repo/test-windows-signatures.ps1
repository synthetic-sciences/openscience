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

    # A new embedded signature does not change the hash used by the OS catalog.
    # Reproduce PowerShell selecting Microsoft while our embedded signer differs.
    $catalogued = @('d3dcompiler_47.dll', 'kernel32.dll', 'ntdll.dll') | ForEach-Object { Join-Path "$env:windir/System32" $_ } | Where-Object {
        (Get-AuthenticodeSignature -LiteralPath $_).SignatureType -eq 'Catalog'
    } | Select-Object -First 1
    if (-not $catalogued) { throw 'A catalog-signed Windows DLL is required for this regression test' }
    $fixture = Join-Path $directory 'catalogued.dll'
    Copy-Item -LiteralPath $catalogued -Destination $fixture
    $sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
    $tool = Get-ChildItem -Path "$sdk/*/x64/signtool.exe" -File | Sort-Object { [version]$_.Directory.Parent.Name } -Descending | Select-Object -First 1
    if ($null -eq $tool) { throw 'Windows SDK SignTool is required for this regression test' }
    & $tool.FullName sign /s My /sha1 $certificate.Thumbprint /fd SHA256 $fixture
    if ($LASTEXITCODE -ne 0) { throw 'Could not sign the catalog regression fixture' }
    if ((Get-AuthenticodeSignature -LiteralPath $fixture).SignatureType -ne 'Catalog') { throw 'The regression fixture must retain its OS catalog signature' }
    Assert-Rejected $fixture 'OpenScience Signing Test' 'Invalid embedded Authenticode signature or timestamp'
    & $tool.FullName timestamp /tr 'http://timestamp.acs.microsoft.com' /td SHA256 $fixture
    if ($LASTEXITCODE -ne 0) { throw 'Could not timestamp the catalog regression fixture' }
    & $verifier -Files $fixture -Publisher 'OpenScience Signing Test'
    Assert-Rejected $fixture 'Wrong Publisher Inc.' 'Unexpected publisher'
    Write-Output 'Windows signature verification checks passed'
}
finally {
    if ($null -ne $certificate) {
        Remove-Item -LiteralPath "Cert:\LocalMachine\Root\$($certificate.Thumbprint)" -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $directory -Recurse -Force
}
