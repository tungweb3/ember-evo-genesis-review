# EmberEvoGenesis Ethereum MAINNET deploy (owner 2026-11-01). Real network, real ETH for gas. Run from this folder:
#   powershell -ExecutionPolicy Bypass -File deploy-mainnet.ps1
# What it does, in order:
#   1. Creates the mainnet approval-signer key and the mainnet reveal seed in your home folder if they do not exist yet
#      (never printed, never overwritten). Back both files up offline afterwards: losing them stops free approvals,
#      paid approvals and reveals.
#   2. Asks for your deployer wallet address, its private key and a mainnet RPC URL (keys are not echoed, kept only in
#      this process, nothing secret is written to disk).
#   3. Checks on chain first (imdUSD, USDC, the Safe's owners and threshold, your ETH balance) and shows a summary.
#   4. After you type DEPLOY: deploys, locks the metadata URIs, sets the reveal commitment, adds USDC (usable in two days),
#      approves the paid price and hands ownership to the Safe (the Safe still has to accept it).
#   5. Writes the Safe Transaction Builder file for acceptOwnership next to the deployment record.
# Minting stays paused: it opens only when the Safe sets the free list and the opening time (safe-batch.mjs open).
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$Safe = '0x29e7c208481f648795f677b55F6ECb2bADc2F01E'

function Read-Secret([string]$prompt) {
  $s = Read-Host $prompt -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { throw 'Node.js not found on PATH. Install Node 24, then run this again. Nothing was created or sent.' }
Set-Alias node $Node
$RuntimeHook = 'file:///' + ((Join-Path $PSScriptRoot 'contract\tools\runtime-local-hook.mjs') -replace '\\','/')

# 1. Mainnet signer key and reveal seed (separate files, separate secrets).
$keyFile = Join-Path $HOME 'genesis-signer-mainnet.key'
if (-not (Test-Path $keyFile)) {
  node signer/tools/new-signer-key.mjs mainnet | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the mainnet signer key.' }
  Write-Host "New mainnet signer key written to $keyFile"
}
$signer = (node --input-type=module -e "import {readFileSync} from 'node:fs';import {Wallet} from './vendor/ethers.min.js';console.log(new Wallet(readFileSync(process.argv[1],'utf8').trim()).address)" $keyFile).Trim()
$seedFile = Join-Path $HOME 'genesis-reveal-seed-mainnet.key'
if (-not (Test-Path $seedFile)) {
  node signer/tools/new-reveal-seed.mjs mainnet | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the mainnet reveal seed.' }
  Write-Host "New mainnet reveal seed written to $seedFile"
}
$revealCommit = ((node signer/tools/new-reveal-seed.mjs mainnet --anchor) | ConvertFrom-Json).revealCommit
Write-Host "Approval signer address: $signer"
Write-Host "Reveal commitment (anchor): $revealCommit"

# 2. Deployer and RPC, for this process only.
$expected = (Read-Host 'Your deployer wallet ADDRESS (0x..., needs a little ETH for gas)').Trim()
if ($expected -notmatch '^0x[0-9a-fA-F]{40}$') { throw 'That is not a wallet address. Stopped.' }
$env:RPC_URL = Read-Secret 'Ethereum MAINNET RPC URL (your Alchemy HTTPS)'
$env:DEPLOYER_PRIVATE_KEY = Read-Secret 'Deployer wallet private key'
try {
  $deployer = (node --input-type=module -e "import {Wallet} from './vendor/ethers.min.js';console.log(new Wallet(process.env.DEPLOYER_PRIVATE_KEY.trim()).address)").Trim()
  if ($deployer.ToLower() -ne $expected.ToLower()) { throw "This key belongs to $deployer, not $expected. Stopped." }
  $env:SIGNER_KEY_FILE = $keyFile
  $env:REVEAL_COMMIT = $revealCommit

  # 3. On-chain checks, nothing sent.
  $env:PREFLIGHT_ONLY = '1'
  node --import $RuntimeHook contract/tools/deploy-mainnet.mjs
  if ($LASTEXITCODE -ne 0) { throw "Pre-check failed (exit $LASTEXITCODE). Nothing was sent." }
  Remove-Item Env:PREFLIGHT_ONLY

  Write-Host ''
  Write-Host 'About to deploy on ETHEREUM MAINNET:' -ForegroundColor Yellow
  Write-Host "  deployer        $deployer (owner only until the Safe accepts)"
  Write-Host "  approval signer $signer"
  Write-Host '  contract        EmberEvoGenesis, name "Ember Evo Genesis", symbol EGEN, 1,688 max'
  Write-Host '  price           20 imdUSD + 1,200 GOLD; USDC 20 + 1,600 GOLD usable two days after this deploy'
  Write-Host "  payments to     $Safe (EmberEvo Treasury Safe, 2 of 3)"
  Write-Host '  metadata        https://genesis.imdember.com/meta/  (LOCKED forever)'
  Write-Host "  new owner       $Safe (after the Safe signs acceptOwnership)"
  Write-Host '  minting         stays paused until the Safe sets the free list and the opening time'
  if ((Read-Host 'Type DEPLOY to send these six transactions') -ne 'DEPLOY') { throw 'Cancelled. Nothing was sent.' }

  # 4. Deploy and set up.
  node --import $RuntimeHook contract/tools/deploy-mainnet.mjs
  if ($LASTEXITCODE -ne 0) { throw "Deploy script stopped (exit $LASTEXITCODE). Copy the output above to Claude; do not run this again before checking." }
} finally {
  Remove-Item Env:RPC_URL, Env:DEPLOYER_PRIVATE_KEY, Env:SIGNER_KEY_FILE, Env:PREFLIGHT_ONLY -ErrorAction SilentlyContinue
}

# 5. Safe Transaction Builder file for acceptOwnership.
$record = Get-ChildItem 'contract\deployments\1-*.json' | Where-Object { $_.Name -notmatch '\.safe-' -and $_.Name -notmatch 'snapshot' } | Sort-Object LastWriteTime | Select-Object -Last 1
node --import $RuntimeHook contract/tools/safe-batch.mjs accept $record.FullName
Write-Host ''
Write-Host "Done. Record: $($record.FullName)" -ForegroundColor Green
Write-Host 'Next: back up the two key files in your home folder offline, then tell Claude "deployed".'
