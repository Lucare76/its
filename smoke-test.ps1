param(
  [string]$BaseUrl = "http://localhost:4000",
  [string]$OperatorEmail = "lucarenna76@gmail.com",
  [PSCredential]$OperatorCredential,
  [string]$VehicleName = "Mercedes Vito",
  [string]$AgencyEmail = "smoke.agency@its.local",
  [PSCredential]$AgencyCredential,
  [ValidateSet("quick", "full")]
  [string]$Mode = "full",
  [ValidateSet("none", "json", "csv", "both")]
  [string]$ReportFormat = "none",
  [string]$ReportDir = ".",
  [int]$MaxStepDurationMs = 0,
  [ValidateSet("warn", "fail")]
  [string]$PerfMode = "warn"
)

$ErrorActionPreference = "Stop"
$scriptStart = Get-Date

$results = @()
$token = $null
$headers = $null
$vehicleId = $null
$createdUnavailabilityId = $null
$agencyToken = $null
$agencyHeaders = $null
$testBookingIds = @()
$createdDispatchIds = @()

function Convert-SecureStringToPlainText {
  param([SecureString]$SecureValue)
  if (-not $SecureValue) { return "" }
  $ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  try {
    return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

$resolvedOperatorEmail = if ($OperatorCredential -and $OperatorCredential.UserName) { $OperatorCredential.UserName } else { $OperatorEmail }
$resolvedAgencyEmail = if ($AgencyCredential -and $AgencyCredential.UserName) { $AgencyCredential.UserName } else { $AgencyEmail }

$resolvedOperatorPassword = if ($OperatorCredential) {
  Convert-SecureStringToPlainText -SecureValue $OperatorCredential.Password
} elseif ($env:SMOKE_OPERATOR_PASSWORD) {
  $env:SMOKE_OPERATOR_PASSWORD
} else {
  ""
}

$resolvedAgencyPassword = if ($AgencyCredential) {
  Convert-SecureStringToPlainText -SecureValue $AgencyCredential.Password
} elseif ($env:SMOKE_AGENCY_PASSWORD) {
  $env:SMOKE_AGENCY_PASSWORD
} else {
  ""
}

if ([string]::IsNullOrWhiteSpace($resolvedOperatorPassword)) {
  Write-Host "Credenziali operatore mancanti: usa -OperatorCredential o SMOKE_OPERATOR_PASSWORD" -ForegroundColor Yellow
  exit 1
}

if ($Mode -eq "full" -and [string]::IsNullOrWhiteSpace($resolvedAgencyPassword)) {
  Write-Host "Credenziali agenzia mancanti per mode=full: usa -AgencyCredential o SMOKE_AGENCY_PASSWORD" -ForegroundColor Yellow
  exit 1
}

function Add-Result {
  param(
    [string]$Step,
    [bool]$Passed,
    [string]$Message,
    [double]$DurationMs = 0
  )

  $script:results += [PSCustomObject]@{
    Step = $Step
    Passed = $Passed
    Message = $Message
    DurationMs = [Math]::Round($DurationMs, 2)
  }

  if ($Passed) {
    Write-Host "PASS - $Step - $Message" -ForegroundColor Green
  } else {
    Write-Host "FAIL - $Step - $Message" -ForegroundColor Red
  }
}

function Invoke-Checked {
  param(
    [string]$Step,
    [scriptblock]$Action
  )

  $started = Get-Date
  try {
    $output = & $Action
    $durationMs = ((Get-Date) - $started).TotalMilliseconds
    Add-Result -Step $Step -Passed $true -Message "OK" -DurationMs $durationMs
    return $output
  } catch {
    $durationMs = ((Get-Date) - $started).TotalMilliseconds
    Add-Result -Step $Step -Passed $false -Message $_.Exception.Message -DurationMs $durationMs
    return $null
  }
}

Write-Host "=== ITS Smoke Test Start ===" -ForegroundColor Cyan
Write-Host "Base URL: $BaseUrl"
Write-Host "Mode: $Mode"
Write-Host "Report: $ReportFormat"
if ($MaxStepDurationMs -gt 0) {
  Write-Host "Performance threshold: ${MaxStepDurationMs}ms ($PerfMode)"
}

$health = Invoke-Checked -Step "Health endpoint" -Action {
  Invoke-RestMethod -Method GET -Uri "$BaseUrl/api/health"
}

if (-not $health -or -not $health.ok) {
  Write-Host "\nServer non raggiungibile o /api/health non OK. Avvia prima il backend." -ForegroundColor Yellow
  Write-Host "Comando: npm --prefix server run dev"
  exit 1
}

$login = Invoke-Checked -Step "Login operatore" -Action {
  Invoke-RestMethod -Method POST -Uri "$BaseUrl/api/auth/login" -ContentType "application/json" -Body (@{
    email = $resolvedOperatorEmail
    password = $resolvedOperatorPassword
  } | ConvertTo-Json)
}

if ($login -and $login.token) {
  $token = $login.token
  $headers = @{ Authorization = "Bearer $token" }
} else {
  Write-Host "\nToken non disponibile, test interrotti." -ForegroundColor Yellow
  exit 1
}

$agencyLogin = $null
try {
  $agencyLogin = Invoke-RestMethod -Method POST -Uri "$BaseUrl/api/auth/login" -ContentType "application/json" -Body (@{
    email = $resolvedAgencyEmail
    password = $resolvedAgencyPassword
  } | ConvertTo-Json)
  Add-Result -Step "Login agenzia test" -Passed $true -Message "OK"
} catch {
  try {
    Invoke-RestMethod -Method POST -Uri "$BaseUrl/api/auth/register" -ContentType "application/json" -Body (@{
      name = "Agenzia Smoke Test"
      email = $resolvedAgencyEmail
      password = $resolvedAgencyPassword
    } | ConvertTo-Json) | Out-Null
    Add-Result -Step "Registrazione agenzia test" -Passed $true -Message "OK"

    $agencyLogin = Invoke-RestMethod -Method POST -Uri "$BaseUrl/api/auth/login" -ContentType "application/json" -Body (@{
      email = $resolvedAgencyEmail
      password = $resolvedAgencyPassword
    } | ConvertTo-Json)
    Add-Result -Step "Login agenzia test" -Passed $true -Message "OK"
  } catch {
    Add-Result -Step "Login/registrazione agenzia test" -Passed $false -Message $_.Exception.Message
  }
}

if ($agencyLogin -and $agencyLogin.token) {
  $agencyToken = $agencyLogin.token
  $agencyHeaders = @{ Authorization = "Bearer $agencyToken" }
} else {
  Write-Host "\nToken agenzia non disponibile, test batch ridotto." -ForegroundColor Yellow
}

$vehicles = Invoke-Checked -Step "Lista mezzi" -Action {
  Invoke-RestMethod -Method GET -Uri "$BaseUrl/api/vehicles" -Headers $headers
}

if ($vehicles -and $vehicles.Count -gt 0) {
  $selectedVehicle = $vehicles | Where-Object { $_.name -eq $VehicleName } | Select-Object -First 1
  if (-not $selectedVehicle) {
    $selectedVehicle = $vehicles | Select-Object -First 1
  }
  $vehicleId = $selectedVehicle.id
  $VehicleName = $selectedVehicle.name
  Add-Result -Step "Selezione mezzo test" -Passed $true -Message "Mezzo: $VehicleName (id=$vehicleId)"
} else {
  Add-Result -Step "Selezione mezzo test" -Passed $false -Message "Nessun mezzo disponibile"
  exit 1
}

$startAt = (Get-Date).AddHours(2)
$endAt = (Get-Date).AddHours(4)
$midAt = (Get-Date).AddHours(3)

$createdBlock = Invoke-Checked -Step "Crea indisponibilita mezzo" -Action {
  Invoke-RestMethod -Method POST -Uri "$BaseUrl/api/vehicles/$vehicleId/unavailability" -Headers $headers -ContentType "application/json" -Body (@{
    startAt = $startAt.ToString("o")
    endAt = $endAt.ToString("o")
    reason = "Smoke test"
  } | ConvertTo-Json)
}

if ($createdBlock -and $createdBlock.id) {
  $createdUnavailabilityId = $createdBlock.id
}

$availability = Invoke-Checked -Step "Verifica disponibilita mezzo in slot bloccato" -Action {
  Invoke-RestMethod -Method GET -Uri "$BaseUrl/api/dispatch/vehicle-availability?vehicle=$([uri]::EscapeDataString($VehicleName))&scheduledAt=$([uri]::EscapeDataString($midAt.ToString('o')))" -Headers $headers
}

if ($availability) {
  if ($availability.ok -eq $false) {
    Add-Result -Step "Esito disponibilita atteso" -Passed $true -Message "Mezzo correttamente non disponibile"
  } else {
    Add-Result -Step "Esito disponibilita atteso" -Passed $false -Message "Atteso ok=false ma ricevuto ok=true"
  }
}

$unavailabilityList = Invoke-Checked -Step "Lista indisponibilita mezzi" -Action {
  Invoke-RestMethod -Method GET -Uri "$BaseUrl/api/vehicles/unavailability" -Headers $headers
}

if ($unavailabilityList -and $createdUnavailabilityId) {
  $exists = $unavailabilityList | Where-Object { $_.id -eq $createdUnavailabilityId }
  if ($exists) {
    Add-Result -Step "Verifica blocco in lista" -Passed $true -Message "Blocco trovato"
  } else {
    Add-Result -Step "Verifica blocco in lista" -Passed $false -Message "Blocco non trovato"
  }
}

$today = (Get-Date).ToString("yyyy-MM-dd")
Invoke-Checked -Step "Endpoint grouped arrivals" -Action {
  Invoke-RestMethod -Method GET -Uri "$BaseUrl/api/dispatch/grouped-arrivals?date=$today&mode=SHIP&windowMinutes=30" -Headers $headers
} | Out-Null

if ($Mode -eq "full" -and $agencyHeaders) {
  $travelRef = "SMOKE-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
  $arrivalAt1 = (Get-Date).ToUniversalTime().AddHours(1)
  $arrivalAt2 = $arrivalAt1.AddMinutes(5)

  $booking1 = Invoke-Checked -Step "Crea booking test #1" -Action {
    Invoke-RestMethod -Method POST -Uri "$BaseUrl/api/bookings" -Headers $agencyHeaders -ContentType "application/json" -Body (@{
      service = "transfer"
      passengers = 2
      travelMode = "SHIP"
      travelRef = $travelRef
      arrivalAt = $arrivalAt1.ToString("o")
    } | ConvertTo-Json)
  }

  $booking2 = Invoke-Checked -Step "Crea booking test #2" -Action {
    Invoke-RestMethod -Method POST -Uri "$BaseUrl/api/bookings" -Headers $agencyHeaders -ContentType "application/json" -Body (@{
      service = "transfer"
      passengers = 3
      travelMode = "SHIP"
      travelRef = $travelRef
      arrivalAt = $arrivalAt2.ToString("o")
    } | ConvertTo-Json)
  }

  if ($booking1 -and $booking1.id) { $testBookingIds += [int]$booking1.id }
  if ($booking2 -and $booking2.id) { $testBookingIds += [int]$booking2.id }

  foreach ($bookingId in $testBookingIds) {
    Invoke-Checked -Step "Approva booking test $bookingId" -Action {
      Invoke-RestMethod -Method PUT -Uri "$BaseUrl/api/bookings/$bookingId/approve" -Headers $headers
    } | Out-Null
  }

  $groupDate = $arrivalAt1.ToString("yyyy-MM-dd")
  $grouped = Invoke-Checked -Step "Grouped arrivals per booking test" -Action {
    Invoke-RestMethod -Method GET -Uri "$BaseUrl/api/dispatch/grouped-arrivals?date=$groupDate&mode=SHIP&windowMinutes=30" -Headers $headers
  }

  $targetGroup = $null
  if ($grouped -and $grouped.groups) {
    foreach ($group in $grouped.groups) {
      $groupBookingIds = @($group.bookings | ForEach-Object { [int]$_.id })
      $foundAll = ($testBookingIds | Where-Object { $groupBookingIds -contains $_ }).Count -eq $testBookingIds.Count
      if ($foundAll) {
        $targetGroup = $group
        break
      }
    }
  }

  if ($targetGroup -and $testBookingIds.Count -gt 0) {
    $dispatchTime = (Get-Date).ToUniversalTime().AddHours(6)
    $batchResult = Invoke-Checked -Step "Batch create dispatch da gruppo" -Action {
      Invoke-RestMethod -Method POST -Uri "$BaseUrl/api/dispatch/grouped-arrivals/create-dispatch" -Headers $headers -ContentType "application/json" -Body (@{
        bookingIds = $testBookingIds
        scheduledAt = $dispatchTime.ToString("o")
        vehicle = $VehicleName
        driverName = "Driver Smoke Test"
        notes = "Batch smoke test"
      } | ConvertTo-Json)
    }

    if ($batchResult) {
      if ([int]$batchResult.created -ge $testBookingIds.Count) {
        Add-Result -Step "Esito batch dispatch atteso" -Passed $true -Message "Create $($batchResult.created) su $($testBookingIds.Count)"
      } else {
        Add-Result -Step "Esito batch dispatch atteso" -Passed $false -Message "Create $($batchResult.created) su $($testBookingIds.Count)"
      }
    }
  } else {
    Add-Result -Step "Ricerca gruppo test" -Passed $false -Message "Gruppo test non trovato"
  }
} elseif ($Mode -eq "full" -and -not $agencyHeaders) {
  Add-Result -Step "Batch test mode full" -Passed $false -Message "Token agenzia non disponibile"
} else {
  Add-Result -Step "Batch test mode" -Passed $true -Message "Saltato (mode=quick)"
}

$dispatchListForCleanup = Invoke-Checked -Step "Lista dispatch per cleanup" -Action {
  Invoke-RestMethod -Method GET -Uri "$BaseUrl/api/dispatch" -Headers $headers
}

if ($dispatchListForCleanup -and $testBookingIds.Count -gt 0) {
  $toDelete = @($dispatchListForCleanup | Where-Object { $testBookingIds -contains [int]$_.bookingId })
  foreach ($entry in $toDelete) {
    if ($entry.id) {
      $createdDispatchIds += [int]$entry.id
      Invoke-Checked -Step "Delete dispatch test $($entry.id)" -Action {
        Invoke-RestMethod -Method DELETE -Uri "$BaseUrl/api/dispatch/$($entry.id)" -Headers $headers
      } | Out-Null
    }
  }
}

foreach ($bookingId in $testBookingIds) {
  Invoke-Checked -Step "Delete booking test $bookingId" -Action {
    Invoke-RestMethod -Method DELETE -Uri "$BaseUrl/api/bookings/$bookingId" -Headers $headers
  } | Out-Null
}

if ($createdUnavailabilityId) {
  Invoke-Checked -Step "Rimozione indisponibilita test" -Action {
    Invoke-RestMethod -Method DELETE -Uri "$BaseUrl/api/vehicles/unavailability/$createdUnavailabilityId" -Headers $headers
  } | Out-Null
}

$passedCount = ($results | Where-Object { $_.Passed }).Count
$failedCount = ($results | Where-Object { -not $_.Passed }).Count
$totalCount = $results.Count
$successRate = if ($totalCount -gt 0) { [Math]::Round(($passedCount / $totalCount) * 100, 2) } else { 0 }
$durationSeconds = [Math]::Round(((Get-Date) - $scriptStart).TotalSeconds, 2)
$slowestSteps = @($results | Sort-Object -Property DurationMs -Descending | Select-Object -First 3)
$performanceBreaches = @()

if ($MaxStepDurationMs -gt 0) {
  $performanceBreaches = @($results | Where-Object { $_.DurationMs -gt $MaxStepDurationMs })
  if ($performanceBreaches.Count -gt 0) {
    Write-Host "Performance breaches detected: $($performanceBreaches.Count)" -ForegroundColor Yellow
    $performanceBreaches | ForEach-Object {
      Write-Host "- $($_.Step): $($_.DurationMs)ms > ${MaxStepDurationMs}ms" -ForegroundColor Yellow
    }

    if ($PerfMode -eq "fail") {
      foreach ($breach in $performanceBreaches) {
        Add-Result -Step "Perf threshold - $($breach.Step)" -Passed $false -Message "${($breach.DurationMs)}ms > ${MaxStepDurationMs}ms"
      }
    }
  }
}

$passedCount = ($results | Where-Object { $_.Passed }).Count
$failedCount = ($results | Where-Object { -not $_.Passed }).Count
$totalCount = $results.Count
$successRate = if ($totalCount -gt 0) { [Math]::Round(($passedCount / $totalCount) * 100, 2) } else { 0 }

Write-Host "\n=== ITS Smoke Test Summary ===" -ForegroundColor Cyan
Write-Host "Passed: $passedCount"
Write-Host "Failed: $failedCount"
Write-Host "Total: $totalCount"
Write-Host "Success rate: $successRate%"
Write-Host "Duration: ${durationSeconds}s"

if ($slowestSteps.Count -gt 0) {
  Write-Host "Slowest steps:" -ForegroundColor Cyan
  $slowestSteps | ForEach-Object {
    Write-Host "- $($_.Step): $($_.DurationMs)ms"
  }
}

if ($ReportFormat -ne "none") {
  try {
    New-Item -ItemType Directory -Path $ReportDir -Force | Out-Null
    $timestamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
    $summary = [PSCustomObject]@{
      generatedAt = (Get-Date).ToString("o")
      baseUrl = $BaseUrl
      mode = $Mode
      reportFormat = $ReportFormat
      passed = $passedCount
      failed = $failedCount
      total = $totalCount
      successRate = $successRate
      durationSeconds = $durationSeconds
      maxStepDurationMs = $MaxStepDurationMs
      perfMode = $PerfMode
      performanceBreaches = $performanceBreaches
      slowestSteps = $slowestSteps
      items = $results
    }

    if ($ReportFormat -eq "json" -or $ReportFormat -eq "both") {
      $jsonPath = Join-Path $ReportDir "smoke-test-report-$timestamp.json"
      $summary | ConvertTo-Json -Depth 8 | Set-Content -Path $jsonPath -Encoding UTF8
      Write-Host "Report JSON: $jsonPath" -ForegroundColor Cyan
    }

    if ($ReportFormat -eq "csv" -or $ReportFormat -eq "both") {
      $csvPath = Join-Path $ReportDir "smoke-test-report-$timestamp.csv"
      $results | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8
      Write-Host "Report CSV: $csvPath" -ForegroundColor Cyan
    }
  } catch {
    Add-Result -Step "Export report" -Passed $false -Message $_.Exception.Message
  }
}

if ($failedCount -gt 0) {
  Write-Host "\nDettagli errori:" -ForegroundColor Yellow
  $results | Where-Object { -not $_.Passed } | ForEach-Object {
    Write-Host "- $($_.Step): $($_.Message)" -ForegroundColor Yellow
  }
  exit 1
}

Write-Host "\nSmoke test completato con successo." -ForegroundColor Green
exit 0
