param(
    [Parameter(Mandatory = $true)][string[]]$Files,
    [Parameter(Mandatory = $true)][string]$Publisher
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Publisher)) { throw 'Expected publisher is required' }

foreach ($file in $Files) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing signed file: $file" }
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.SignatureType -eq 'Catalog') {
        # PowerShell prefers the OS catalog even after a DLL has been re-signed.
        # SignTool without catalog switches verifies the embedded signature.
        $sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
        $tool = Get-ChildItem -Path "$sdk/*/x64/signtool.exe" -File | Sort-Object { [version]$_.Directory.Parent.Name } -Descending | Select-Object -First 1
        if ($null -eq $tool) { throw 'Windows SDK SignTool is required to verify embedded signatures' }
        $output = & $tool.FullName verify /pa /all /tw $file 2>&1
        if ($LASTEXITCODE -ne 0) { throw "Invalid embedded Authenticode signature or timestamp on ${file}: $output" }
        $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
            [System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile((Resolve-Path -LiteralPath $file).Path)
        )
        $name = $certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
        $certificate.Dispose()
        if ($name -cne $Publisher) { throw "Unexpected publisher on ${file}: $name" }
        Write-Output "Verified $file ($name)"
        continue
    }
    if ($signature.Status -ne 'Valid') {
        throw "Invalid Authenticode signature on ${file}: $($signature.Status) - $($signature.StatusMessage)"
    }
    $name = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    if ($name -cne $Publisher) { throw "Unexpected publisher on ${file}: $name" }
    if ($null -eq $signature.TimeStamperCertificate) { throw "Missing signature timestamp on $file" }
    Write-Output "Verified $file ($name)"
}
