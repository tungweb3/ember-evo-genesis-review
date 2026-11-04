# EmberEvoGenesis Ethereum MAINNET deploy (owner 2026-11-01). Real network, real ETH for gas. Run from this folder:
#   powershell -ExecutionPolicy Bypass -File deploy-mainnet.ps1
# What it does, in order:
#   1. Creates the mainnet approval-signer key and the mainnet reveal seed in your home folder if they do not exist yet
#      (never printed, never overwritten). Back both files up offline afterwards: losing them stops free approvals,
#      paid approvals and reveals.
#   2. Asks for your deployer wallet address, its private key and a mainnet RPC URL (keys are not echoed, kept only in
#      this process, nothing secret is written to disk). Only the key check and the deploy itself get the key.
#   3. Checks first, sending nothing: the local build against the reviewed one, then on chain imdUSD, USDC, the Safe's owners
#      and threshold, your ETH balance. Shows a summary.
#   4. After you type DEPLOY: deploys, stores the metadata URIs (not locked), sets the reveal commitment, adds USDC (usable
#      in two days), approves the paid price and hands ownership to the Safe (the Safe still has to accept it).
#      If a run stopped, contract\deployments holds a partial record: run this script again, it offers RESUME and sends only what is missing.
#   5. Writes the Safe Transaction Builder file for acceptOwnership next to the deployment record.
# Minting stays paused: it opens only when the Safe locks the URIs and sets the free list and the opening time (safe-batch.mjs open).
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
# a bad key must never reach the screen: an ethers error quotes the value it refused
$signer = node --input-type=module -e "import {readFileSync} from 'node:fs';import {Wallet} from './vendor/ethers.min.js';try{console.log(new Wallet(readFileSync(process.argv[1],'utf8').trim()).address)}catch{process.exit(1)}" $keyFile
if ($LASTEXITCODE -ne 0) { throw 'The mainnet signer key file is not a valid key. Nothing was sent.' }
$signer = $signer.Trim()
$seedFile = Join-Path $HOME 'genesis-reveal-seed-mainnet.key'
if (-not (Test-Path $seedFile)) {
  node signer/tools/new-reveal-seed.mjs mainnet | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the mainnet reveal seed.' }
  Write-Host "New mainnet reveal seed written to $seedFile"
}
$revealCommit = ((node signer/tools/new-reveal-seed.mjs mainnet --anchor) | ConvertFrom-Json).revealCommit
Write-Host "Approval signer address: $signer"
Write-Host "Reveal commitment (anchor): $revealCommit"

# A stopped run is resumed, never deployed a second time.
$partial = @(Get-ChildItem 'contract\deployments\partial-1-*.json' -ErrorAction SilentlyContinue)
$modeArgs = @()
if ($partial.Count -gt 0) {
  Write-Host ''
  Write-Host "An earlier run stopped: $($partial[0].Name). This run will send only the steps the chain does not show yet." -ForegroundColor Yellow
  $modeArgs = @('--resume')
}

# 2. Deployer and RPC, for this process only. The RPC URL reaches only the two node calls that need it.
Write-Host 'Use a fresh wallet that holds only the gas: until the Safe accepts, this key has every owner power over the contract. The pre-check refuses a wallet that has already sent transactions.'
try {
  $expected = (Read-Host 'Your deployer wallet ADDRESS (0x..., needs a little ETH for gas)').Trim()
  if ($expected -notmatch '^0x[0-9a-fA-F]{40}$') { throw 'That is not a wallet address. Stopped.' }
  $rpcUrl = Read-Secret 'Ethereum MAINNET RPC URL (your Alchemy HTTPS)'
  $deployerKey = Read-Secret 'Deployer wallet private key'
  $env:DEPLOYER_PRIVATE_KEY = $deployerKey
  $deployer = node --input-type=module -e "import {Wallet} from './vendor/ethers.min.js';try{console.log(new Wallet(process.env.DEPLOYER_PRIVATE_KEY.trim()).address)}catch{process.exit(1)}"
  $keyExit = $LASTEXITCODE
  Remove-Item Env:DEPLOYER_PRIVATE_KEY -ErrorAction SilentlyContinue
  if ($keyExit -ne 0) { throw 'That is not a valid private key (what you typed is not shown). Nothing was sent.' }
  $deployer = $deployer.Trim()
  if ($deployer.ToLower() -ne $expected.ToLower()) { throw "This key belongs to $deployer, not $expected. Stopped." }

  # 3. Build and on-chain checks, nothing sent: the addresses are enough.
  $env:PREFLIGHT_ONLY = '1'
  $env:DEPLOYER_ADDRESS = $deployer
  $env:SIGNER_ADDRESS = $signer
  $env:RPC_URL = $rpcUrl
  node --import $RuntimeHook contract/tools/deploy-mainnet.mjs @modeArgs
  $checkExit = $LASTEXITCODE
  Remove-Item Env:RPC_URL
  if ($checkExit -ne 0) { throw "Pre-check failed (exit $checkExit). Nothing was sent." }
  Remove-Item Env:PREFLIGHT_ONLY, Env:DEPLOYER_ADDRESS, Env:SIGNER_ADDRESS

  Write-Host ''
  Write-Host 'About to deploy on ETHEREUM MAINNET:' -ForegroundColor Yellow
  Write-Host "  deployer        $deployer (owner only until the Safe accepts)"
  Write-Host "  approval signer $signer"
  Write-Host '  contract        EmberEvoGenesis, name "Ember Evo Genesis", symbol EGEN, 1,688 max'
  Write-Host '  price           20 imdUSD + 1,200 GOLD; USDC 20 + 1,600 GOLD usable two days after this deploy'
  Write-Host "  payments to     $Safe (EmberEvo Treasury Safe, 2 of 3)"
  Write-Host '  metadata        https://genesis.imdember.com/meta/  (locks only when the Safe opens minting)'
  Write-Host "  new owner       $Safe (after the Safe signs acceptOwnership)"
  Write-Host '  minting         stays paused until the Safe sets the free list and the opening time'
  if ($modeArgs.Count -gt 0) {
    if ((Read-Host 'Type RESUME to send only the missing transactions') -ne 'RESUME') { throw 'Cancelled. Nothing was sent.' }
  } else {
    if ((Read-Host 'Type DEPLOY to send these six transactions') -ne 'DEPLOY') { throw 'Cancelled. Nothing was sent.' }
  }

  # 4. Deploy and set up.
  $env:RPC_URL = $rpcUrl
  $env:DEPLOYER_PRIVATE_KEY = $deployerKey
  $env:SIGNER_KEY_FILE = $keyFile
  $env:REVEAL_COMMIT = $revealCommit
  node --import $RuntimeHook contract/tools/deploy-mainnet.mjs @modeArgs
  $deployExit = $LASTEXITCODE
  Remove-Item Env:RPC_URL, Env:DEPLOYER_PRIVATE_KEY, Env:SIGNER_KEY_FILE, Env:REVEAL_COMMIT
  if ($deployExit -eq 2) { throw 'The run finished but a value read back from the chain differs (readBackMismatch above). Do not sign anything in the Safe before checking it.' }
  if ($deployExit -ne 0) { throw "Deploy script stopped (exit $deployExit, last step above). Its progress is saved in contract\deployments\partial-1-*.json. Check the deployer on Etherscan, then run this script again: it offers RESUME. Share only the error above and that file, never your RPC URL." }
} finally {
  $rpcUrl = $null
  $deployerKey = $null
  Remove-Item Env:RPC_URL, Env:DEPLOYER_PRIVATE_KEY, Env:SIGNER_KEY_FILE, Env:REVEAL_COMMIT, Env:PREFLIGHT_ONLY, Env:DEPLOYER_ADDRESS, Env:SIGNER_ADDRESS -ErrorAction SilentlyContinue
}

# 5. Safe Transaction Builder file for acceptOwnership (reads the chain through a public RPC: no secret needed from here on).
$record = Get-ChildItem 'contract\deployments\1-*.json' | Where-Object { $_.Name -notmatch '\.safe-' -and $_.Name -notmatch 'snapshot' } | Sort-Object LastWriteTime | Select-Object -Last 1
node --import $RuntimeHook contract/tools/safe-batch.mjs accept $record.FullName
if ($LASTEXITCODE -ne 0) { throw "Could not write the acceptOwnership file (exit $LASTEXITCODE). Run: node --import `"$RuntimeHook`" contract/tools/safe-batch.mjs accept `"$($record.FullName)`"" }
Write-Host ''
Write-Host "Done. Record: $($record.FullName)" -ForegroundColor Green
Write-Host 'NOT finished until the Safe signs acceptOwnership: until then this deployer key still owns the contract.' -ForegroundColor Yellow
Write-Host 'Do it now, then check with: safe-batch.mjs status <record> (owner must be the Safe). Treat the deployer key as burned afterwards.'
Write-Host 'Next: back up the two key files in your home folder offline, then tell Claude "deployed".'
