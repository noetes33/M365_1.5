# Run on the SAME machine that hosts m365-copilot-console. No credentials are sent through HTTP.
param(
  [ValidateSet('set','status','remove')][string]$Action = 'set',
  [string]$AccountId = ''
)
$ErrorActionPreference = 'Stop'
if (-not $AccountId) { $AccountId = Read-Host 'Enter isolated Microsoft account UUID (from the management database)' }
$tool = Join-Path $PSScriptRoot 'account-credentials.mjs'
if (-not (Test-Path $tool)) { throw 'Credential helper not found' }
if ($Action -ne 'set') {
  & node $tool $Action $AccountId
  if ($LASTEXITCODE -ne 0) { throw 'Credential helper failed' }
  return
}
$passSecure = Read-Host 'Microsoft work/school account password (input hidden)' -AsSecureString
$seedSecure = Read-Host 'TOTP Base32 seed (not a six-digit OTP; input hidden)' -AsSecureString
try {
  $password = [System.Net.NetworkCredential]::new('', $passSecure).Password
  $seed = [System.Net.NetworkCredential]::new('', $seedSecure).Password
  $inputJson = @{password=$password;mfaSecret=$seed} | ConvertTo-Json -Compress
  $inputJson | & node $tool set $AccountId
  if ($LASTEXITCODE -ne 0) { throw 'Credential helper failed' }
} finally {
  Remove-Variable password,seed,inputJson,passSecure,seedSecure -ErrorAction SilentlyContinue
}
