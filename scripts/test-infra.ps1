[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$TemporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('spiderwebrouter-infra-test-' + [Guid]::NewGuid().ToString('N'))

function Assert-Condition {
    param(
        [Parameter(Mandatory)][bool]$Condition,
        [Parameter(Mandatory)][string]$Message
    )
    if (-not $Condition) {
        throw "infra test failed: $Message"
    }
}

Push-Location $RepoRoot
try {
    $tokens = $null
    $errors = $null
    [Management.Automation.Language.Parser]::ParseFile(
        (Resolve-Path 'scripts/init-env.ps1'),
        [ref]$tokens,
        [ref]$errors
    ) | Out-Null
    Assert-Condition ($errors.Count -eq 0) 'init-env.ps1 has syntax errors'

    . (Resolve-Path 'scripts/init-env.ps1')

    $testEnvironment = Join-Path $TemporaryRoot '.env'
    $testSecrets = Join-Path $TemporaryRoot 'secrets'
    New-Item -ItemType Directory -Path $testSecrets | Out-Null
    Set-Content -LiteralPath $testEnvironment -Value 'test=true' -Encoding ascii
    foreach ($secretName in $SecretNames) {
        Set-Content -LiteralPath (Join-Path $testSecrets $secretName) -Value 'test-secret' -NoNewline -Encoding ascii
    }
    Set-SafeSecretPermissions -EnvironmentPath $testEnvironment -SecretsPath $testSecrets

    $isWindowsPlatform = [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
        [Runtime.InteropServices.OSPlatform]::Windows
    )
    if ($isWindowsPlatform) {
        $environmentAcl = Get-Acl -LiteralPath $testEnvironment
        $secretsAcl = Get-Acl -LiteralPath $testSecrets
        Assert-Condition $environmentAcl.AreAccessRulesProtected '.env still inherits Windows ACLs'
        Assert-Condition $secretsAcl.AreAccessRulesProtected 'secrets directory still inherits Windows ACLs'
    }
    else {
        Assert-Condition ((& stat -c '%a' $testEnvironment) -eq '600') '.env is not mode 600'
        Assert-Condition ((& stat -c '%a' $testSecrets) -eq '700') 'secrets directory is not mode 700'
        foreach ($secretName in $SecretNames) {
            Assert-Condition ((& stat -c '%a' (Join-Path $testSecrets $secretName)) -eq '644') "$secretName is not mode 644"
        }
    }

    Get-Content -Raw 'docker/keycloak/realm-export.json' | ConvertFrom-Json | Out-Null

    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        $composeJson = & docker compose --env-file .env.example -f docker-compose.yml config --format json 2>$null
        $composeExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    Assert-Condition ($composeExitCode -eq 0) 'docker compose config failed'
    $compose = $composeJson | ConvertFrom-Json
    $serviceNames = @($compose.services.PSObject.Properties.Name | Sort-Object)
    $expectedServices = @('api', 'bootstrap', 'edge', 'keycloak', 'migrate', 'postgres', 'redis', 'worker')
    Assert-Condition (($serviceNames -join ',') -eq ($expectedServices -join ',')) 'Compose service set is incorrect'

    $publishedPorts = @()
    foreach ($service in $compose.services.PSObject.Properties) {
        $portsProperty = $service.Value.PSObject.Properties['ports']
        if ($null -eq $portsProperty) {
            continue
        }
        foreach ($port in @($portsProperty.Value)) {
            if ($null -ne $port) {
                $publishedPorts += "{0}:{1}:{2}" -f $service.Name, $port.published, $port.target
            }
        }
    }
    Assert-Condition (($publishedPorts -join ',') -eq 'edge:80:80') 'a service other than edge publishes a host port'

    foreach ($serviceName in @('edge', 'api', 'worker', 'postgres', 'redis', 'keycloak')) {
        Assert-Condition ($null -ne $compose.services.$serviceName.healthcheck) "$serviceName has no healthcheck"
    }

    $apiServiceNames = @('api', 'worker', 'migrate', 'bootstrap')
    $apiImages = @($apiServiceNames | ForEach-Object { $compose.services.$_.image } | Sort-Object -Unique)
    Assert-Condition ($apiImages.Count -eq 1) 'API, worker, migrate, and bootstrap do not share one image'
    Assert-Condition ($null -ne $compose.services.migrate.build) 'migrate must own the shared API image build'
    foreach ($serviceName in @('api', 'worker', 'bootstrap')) {
        Assert-Condition ($null -eq $compose.services.$serviceName.PSObject.Properties['build']) "$serviceName unexpectedly defines a duplicate image build"
        Assert-Condition ($compose.services.$serviceName.pull_policy -eq 'never') "$serviceName may pull instead of consuming the local shared image"
    }

    foreach ($path in @(
        'apps/api/src/main.ts',
        'apps/api/src/worker.ts',
        'apps/api/src/bootstrap.ts',
        'apps/api/prisma/migrations/202608090001_initial/migration.sql'
    )) {
        Assert-Condition (Test-Path -LiteralPath $path -PathType Leaf) "$path is missing"
    }

    $keycloakDockerfile = Get-Content -LiteralPath 'docker/keycloak/Dockerfile' -Raw
    Assert-Condition $keycloakDockerfile.Contains('KC_HTTP_RELATIVE_PATH=/auth') 'Keycloak optimized build is missing KC_HTTP_RELATIVE_PATH=/auth'
    Assert-Condition $keycloakDockerfile.Contains('KC_HTTP_MANAGEMENT_RELATIVE_PATH=/') 'Keycloak optimized build is missing KC_HTTP_MANAGEMENT_RELATIVE_PATH=/'

    $apiDockerfile = Get-Content -LiteralPath 'docker/api/Dockerfile' -Raw
    Assert-Condition (-not $apiDockerfile.Contains('COPY . .')) 'API dependency cache is invalidated by a whole-repository COPY'
    Assert-Condition $apiDockerfile.Contains('--mount=type=cache,id=pnpm-store,target=/pnpm/store') 'API build has no persistent pnpm store cache'
    Assert-Condition $apiDockerfile.Contains('--filter @spiderwebrouter/api...') 'API dependencies are not installed with a workspace filter'
    Assert-Condition $apiDockerfile.Contains('install --frozen-lockfile') 'API dependency install does not enforce the lockfile'
    Assert-Condition $apiDockerfile.Contains('--prod deploy --legacy /prod/apps/api') 'API runtime is not built from a production-only deploy bundle'
    Assert-Condition (-not $apiDockerfile.Contains('/app /app')) 'API runtime still copies the whole monorepo'

    $edgeDockerfile = Get-Content -LiteralPath 'docker/edge/Dockerfile' -Raw
    Assert-Condition (-not $edgeDockerfile.Contains('COPY . .')) 'Web dependency cache is invalidated by a whole-repository COPY'
    Assert-Condition $edgeDockerfile.Contains('--mount=type=cache,id=pnpm-store,target=/pnpm/store') 'Web build has no persistent pnpm store cache'
    Assert-Condition $edgeDockerfile.Contains('--filter @spiderwebrouter/web...') 'Web dependencies are not installed with a workspace filter'
    Assert-Condition $edgeDockerfile.Contains('COPY apps/web ./apps/web') 'Web source is not copied independently from backend source'

    $apiPackage = Get-Content -LiteralPath 'apps/api/package.json' -Raw | ConvertFrom-Json
    Assert-Condition ($null -ne $apiPackage.dependencies.PSObject.Properties['prisma']) 'Prisma CLI is not a production dependency required by migrate'
    Assert-Condition ($null -eq $apiPackage.devDependencies.PSObject.Properties['prisma']) 'Prisma CLI is duplicated in devDependencies'
    Assert-Condition (@($apiPackage.files) -contains 'dist') 'API deploy package omits dist'
    Assert-Condition (@($apiPackage.files) -contains 'prisma') 'API deploy package omits Prisma schema and migrations'

    Write-Output 'infra tests passed'
}
finally {
    Pop-Location
    $expectedPrefix = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'spiderwebrouter-infra-test-')
    if ($TemporaryRoot.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $TemporaryRoot)) {
        Remove-Item -LiteralPath $TemporaryRoot -Recurse -Force
    }
}
