[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $RepoRoot '.env'
$EnvTemplate = Join-Path $RepoRoot '.env.example'
$DefaultSecretsDir = Join-Path $RepoRoot 'secrets'
$SecretNames = @(
    'postgres_password', 'keycloak_db_password', 'redis_password',
    'keycloak_admin_password', 'keycloak_client_secret', 'session_secret',
    'api_key_pepper', 'provider_encryption_key', 'initial_admin_password'
)

function Stop-WithError {
    param([Parameter(Mandatory)][string]$Message)
    throw $Message
}

function Test-Docker {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Stop-WithError "Docker was not found in PATH."
    }

    & docker compose version *> $null
    if ($LASTEXITCODE -ne 0) {
        Stop-WithError "Docker Compose v2 is required."
    }

    & docker info *> $null
    if ($LASTEXITCODE -ne 0) {
        Stop-WithError "Docker is installed but its daemon is not running."
    }
}

function Test-Port80Available {
    $listener = $null
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        $listener = Get-NetTCPConnection -State Listen -LocalPort 80 -ErrorAction SilentlyContinue
    }
    else {
        $listener = netstat -ano 2>$null | Select-String -Pattern '[:.]80\s+.*LISTENING'
    }

    if ($listener) {
        Stop-WithError "TCP port 80 is already in use."
    }
}

function Test-PublicBaseUrl {
    param([Parameter(Mandatory)][string]$Value)

    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -ne 'https' -or
        -not [string]::IsNullOrEmpty($uri.UserInfo) -or
        -not [string]::IsNullOrEmpty($uri.Query) -or
        -not [string]::IsNullOrEmpty($uri.Fragment) -or
        $uri.AbsolutePath -ne '/') {
        Stop-WithError "PUBLIC_BASE_URL must be an HTTPS origin without a path, query, fragment, or trailing slash."
    }
}

function Test-TrustedProxyCidrs {
    param([Parameter(Mandatory)][string]$Value)

    if ($Value -ne 'private_ranges' -and $Value -notmatch '^[0-9A-Fa-f\.:/\s]+$') {
        Stop-WithError "TRUSTED_PROXY_CIDRS must be 'private_ranges' or a space-separated CIDR list."
    }
}

function Test-SessionTimeouts {
    param(
        [Parameter(Mandatory)][string]$IdleSeconds,
        [Parameter(Mandatory)][string]$MaxSeconds
    )

    $idle = 0L
    $maximum = 0L
    if (-not [long]::TryParse($IdleSeconds, [ref]$idle) -or $idle -le 0 -or
        -not [long]::TryParse($MaxSeconds, [ref]$maximum) -or $maximum -le 0) {
        Stop-WithError 'AUTH_SESSION_IDLE_SECONDS and AUTH_SESSION_MAX_SECONDS must be positive integers.'
    }
    if ($idle -gt $maximum) {
        Stop-WithError 'AUTH_SESSION_IDLE_SECONDS must not exceed AUTH_SESSION_MAX_SECONDS.'
    }
}

function Get-EnvironmentSettings {
    param([Parameter(Mandatory)][string]$Path)

    $settings = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^\s*#' -or [string]::IsNullOrWhiteSpace($line)) {
            continue
        }
        if ($line -match '^([^=]+)=(.*)$') {
            $settings[$Matches[1].Trim()] = $Matches[2]
        }
    }
    return $settings
}

function Resolve-SecretsDirectory {
    param([Parameter(Mandatory)][string]$ConfiguredPath)

    if ([IO.Path]::IsPathRooted($ConfiguredPath)) {
        return [IO.Path]::GetFullPath($ConfiguredPath)
    }
    return [IO.Path]::GetFullPath((Join-Path $RepoRoot $ConfiguredPath))
}

function Get-ValidatedSecretsDirectory {
    param([Parameter(Mandatory)][string]$ConfiguredPath)

    $secretsDirectory = Resolve-SecretsDirectory -ConfiguredPath $ConfiguredPath
    if (-not (Test-Path -LiteralPath $secretsDirectory -PathType Container)) {
        Stop-WithError "Secrets directory $secretsDirectory does not exist."
    }

    $directoryItem = Get-Item -LiteralPath $secretsDirectory -Force
    if (($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Stop-WithError "Secrets directory $secretsDirectory must not be a symlink or reparse point."
    }

    $canonical = [IO.Path]::GetFullPath($directoryItem.FullName)
    $trimCharacters = [char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $canonicalForComparison = $canonical.TrimEnd($trimCharacters)
    $rootForComparison = ([IO.Path]::GetPathRoot($canonical)).TrimEnd($trimCharacters)
    $repoForComparison = ([IO.Path]::GetFullPath($RepoRoot)).TrimEnd($trimCharacters)
    if ([string]::Equals($canonicalForComparison, $rootForComparison, [StringComparison]::OrdinalIgnoreCase) -or
        [string]::Equals($canonicalForComparison, $repoForComparison, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-WithError "Refusing to use a filesystem or repository root as SECRETS_DIR."
    }

    foreach ($secretName in $SecretNames) {
        $secretPath = Join-Path $canonical $secretName
        if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
            Stop-WithError "Required secret file $secretPath is missing."
        }
        $secretItem = Get-Item -LiteralPath $secretPath -Force
        if (($secretItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $secretItem.Length -eq 0) {
            Stop-WithError "Required secret $secretPath must be a non-empty regular file, not a symlink or reparse point."
        }
    }

    return $canonical
}

function Test-ExistingEnvironment {
    $settings = Get-EnvironmentSettings -Path $EnvFile
    $requiredKeys = @(
        'PUBLIC_BASE_URL', 'TRUSTED_PROXY_CIDRS', 'INITIAL_ADMIN_EMAIL', 'SECRETS_DIR',
        'POSTGRES_USER', 'POSTGRES_DB', 'KEYCLOAK_DB_USER', 'KEYCLOAK_DB_NAME',
        'KEYCLOAK_ADMIN_USERNAME'
    )

    foreach ($key in $requiredKeys) {
        if (-not $settings.ContainsKey($key) -or [string]::IsNullOrWhiteSpace($settings[$key])) {
            Stop-WithError ".env is missing required value $key."
        }
        if ($settings[$key] -match '^__.*__$') {
            Stop-WithError ".env still contains the placeholder for $key."
        }
    }

    Test-PublicBaseUrl -Value $settings['PUBLIC_BASE_URL']
    Test-TrustedProxyCidrs -Value $settings['TRUSTED_PROXY_CIDRS']
    if ($settings.ContainsKey('AUTH_SESSION_IDLE_SECONDS') -or
        $settings.ContainsKey('AUTH_SESSION_MAX_SECONDS')) {
        Test-SessionTimeouts `
            -IdleSeconds $settings['AUTH_SESSION_IDLE_SECONDS'] `
            -MaxSeconds $settings['AUTH_SESSION_MAX_SECONDS']
    }
    if ($settings['INITIAL_ADMIN_EMAIL'] -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') {
        Stop-WithError "INITIAL_ADMIN_EMAIL is not a valid email address."
    }

    return Get-ValidatedSecretsDirectory -ConfiguredPath $settings['SECRETS_DIR']
}

function New-RandomHex {
    param([Parameter(Mandatory)][int]$ByteCount)

    $bytes = New-Object byte[] $ByteCount
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
        return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $generator.Dispose()
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

function Convert-SecureStringToPlainText {
    param([Parameter(Mandatory)][Security.SecureString]$Value)

    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Set-SafeSecretPermissions {
    param(
        [Parameter(Mandatory)][string]$EnvironmentPath,
        [Parameter(Mandatory)][string]$SecretsPath
    )

    $isWindowsPlatform = [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
        [Runtime.InteropServices.OSPlatform]::Windows
    )

    if (-not $isWindowsPlatform) {
        & chmod 600 -- $EnvironmentPath
        if ($LASTEXITCODE -ne 0) { Stop-WithError "Could not set mode 600 on .env." }
        & chmod 700 -- $SecretsPath
        if ($LASTEXITCODE -ne 0) { Stop-WithError "Could not set mode 700 on the secrets directory." }
        foreach ($secretName in $SecretNames) {
            & chmod 644 -- (Join-Path $SecretsPath $secretName)
            if ($LASTEXITCODE -ne 0) { Stop-WithError "Could not set container-readable mode on $secretName." }
        }
        return
    }

    if (-not (Get-Command icacls.exe -ErrorAction SilentlyContinue)) {
        Stop-WithError "icacls.exe is required to protect .env and secrets on Windows."
    }

    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $EnvironmentPath '/inheritance:r' '/grant:r' "*${currentSid}:(F)" '*S-1-5-18:(F)' *> $null
    if ($LASTEXITCODE -ne 0) {
        Stop-WithError "Could not restrict access to .env."
    }
    & icacls.exe $SecretsPath '/inheritance:r' '/grant:r' "*${currentSid}:(OI)(CI)(F)" '*S-1-5-18:(OI)(CI)(F)' *> $null
    if ($LASTEXITCODE -ne 0) {
        Stop-WithError "Could not restrict access to the secrets directory."
    }
    foreach ($secretName in $SecretNames) {
        $secretPath = Join-Path $SecretsPath $secretName
        & icacls.exe $secretPath '/inheritance:r' '/grant:r' "*${currentSid}:(F)" '*S-1-5-18:(F)' *> $null
        if ($LASTEXITCODE -ne 0) {
            Stop-WithError "Could not protect $secretName while retaining Docker Desktop access."
        }
    }
}

function Invoke-InitEnvironment {
    Push-Location $RepoRoot
    try {
        if (-not (Test-Path -LiteralPath $EnvTemplate -PathType Leaf)) {
            Stop-WithError ".env.example was not found."
        }

        if (Test-Path -LiteralPath $EnvFile) {
            if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
                Stop-WithError ".env exists but is not a regular file."
            }
            $environmentItem = Get-Item -LiteralPath $EnvFile -Force
            if (($environmentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                Stop-WithError ".env must not be a symlink or reparse point."
            }
            $existingSecretsDirectory = Test-ExistingEnvironment
            Set-SafeSecretPermissions -EnvironmentPath $EnvFile -SecretsPath $existingSecretsDirectory
            Test-Docker
            Write-Host 'docker compose up -d'
            return
        }

        Test-Docker
        if (Test-Path -LiteralPath $DefaultSecretsDir) {
            Stop-WithError "The secrets directory already exists. Move it aside before initializing a new environment."
        }
        Test-Port80Available

        $publicBaseUrl = (Read-Host 'Public HTTPS origin (for example https://ai.example.com)').TrimEnd('/')
        Test-PublicBaseUrl -Value $publicBaseUrl

        $trustedProxyCidrs = (Read-Host 'Trusted proxy CIDRs [private_ranges]').Trim()
        if ([string]::IsNullOrWhiteSpace($trustedProxyCidrs)) {
            $trustedProxyCidrs = 'private_ranges'
        }
        Test-TrustedProxyCidrs -Value $trustedProxyCidrs

        $initialAdminEmail = (Read-Host 'Initial super administrator email').Trim()
        if ($initialAdminEmail -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') {
            Stop-WithError "The super administrator email address is invalid."
        }

        do {
            $securePassword = Read-Host 'Initial temporary administrator password (minimum 12 characters)' -AsSecureString
            $initialAdminPassword = Convert-SecureStringToPlainText -Value $securePassword
            if ($initialAdminPassword.Length -lt 12) {
                Write-Error 'Password must contain at least 12 characters.' -ErrorAction Continue
                continue
            }
            $secureConfirmation = Read-Host 'Confirm temporary administrator password' -AsSecureString
            $confirmation = Convert-SecureStringToPlainText -Value $secureConfirmation
            if ($initialAdminPassword -ne $confirmation) {
                Write-Error 'Passwords do not match.' -ErrorAction Continue
                $initialAdminPassword = $null
                $confirmation = $null
                continue
            }
            $confirmation = $null
            break
        } while ($true)

        $temporaryRoot = Join-Path $RepoRoot ('.init-env.' + [Guid]::NewGuid().ToString('N'))
        $temporarySecrets = Join-Path $temporaryRoot 'secrets'
        $temporaryEnvironment = Join-Path $temporaryRoot '.env'
        New-Item -ItemType Directory -Path $temporarySecrets | Out-Null

        try {
            $generatedSecrets = @{
                'postgres_password' = New-RandomHex -ByteCount 32
                'keycloak_db_password' = New-RandomHex -ByteCount 32
                'redis_password' = New-RandomHex -ByteCount 32
                'keycloak_admin_password' = New-RandomHex -ByteCount 32
                'keycloak_client_secret' = New-RandomHex -ByteCount 32
                'session_secret' = New-RandomHex -ByteCount 64
                'api_key_pepper' = New-RandomHex -ByteCount 32
                'provider_encryption_key' = New-RandomHex -ByteCount 32
                'initial_admin_password' = $initialAdminPassword
            }
            foreach ($entry in $generatedSecrets.GetEnumerator()) {
                Set-Content -LiteralPath (Join-Path $temporarySecrets $entry.Key) -Value $entry.Value -NoNewline -Encoding ascii
            }
            $generatedSecrets.Clear()
            $initialAdminPassword = $null

            $environmentLines = foreach ($line in Get-Content -LiteralPath $EnvTemplate) {
                switch ($line) {
                    'PUBLIC_BASE_URL=__PUBLIC_BASE_URL__' { "PUBLIC_BASE_URL=$publicBaseUrl"; continue }
                    'TRUSTED_PROXY_CIDRS=__TRUSTED_PROXY_CIDRS__' { "TRUSTED_PROXY_CIDRS=$trustedProxyCidrs"; continue }
                    'INITIAL_ADMIN_EMAIL=__INITIAL_ADMIN_EMAIL__' { "INITIAL_ADMIN_EMAIL=$initialAdminEmail"; continue }
                    default { $line }
                }
            }
            Set-Content -LiteralPath $temporaryEnvironment -Value $environmentLines -Encoding ascii

            Set-SafeSecretPermissions -EnvironmentPath $temporaryEnvironment -SecretsPath $temporarySecrets
            Move-Item -LiteralPath $temporarySecrets -Destination $DefaultSecretsDir
            Move-Item -LiteralPath $temporaryEnvironment -Destination $EnvFile
        }
        finally {
            if (Test-Path -LiteralPath $temporaryRoot) {
                Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
            }
        }

        $createdSecretsDirectory = Test-ExistingEnvironment
        Set-SafeSecretPermissions -EnvironmentPath $EnvFile -SecretsPath $createdSecretsDirectory
        Write-Host 'docker compose up -d'
    }
    finally {
        Pop-Location
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    Invoke-InitEnvironment
}
