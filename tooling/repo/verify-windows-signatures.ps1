param(
    [Parameter(Mandatory = $true)][string[]]$Files,
    [Parameter(Mandatory = $true)][string]$Publisher
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Publisher)) { throw 'Expected publisher is required' }

foreach ($file in $Files) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing signed file: $file" }
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne 'Valid') {
        throw "Invalid Authenticode signature on ${file}: $($signature.Status) - $($signature.StatusMessage)"
    }
    $name = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    if ($name -cne $Publisher) { throw "Unexpected publisher on ${file}: $name" }
    if ($null -eq $signature.TimeStamperCertificate) { throw "Missing signature timestamp on $file" }
    Write-Output "Verified $file ($name)"
}
