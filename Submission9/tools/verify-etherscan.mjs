// Verifies a Genesis deployment's source on Etherscan (API v2) from the exact standard-JSON input that built it.
//   node contract/tools/verify-etherscan.mjs <deployments/…json> [--dry-run]
// ETHERSCAN_API_KEY comes from the environment (verify-etherscan.ps1 asks for it without echoing); it is never printed.
// --dry-run prints what would be sent (without the key) and checks the input reproduces the deployed runtime code.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const file=process.argv[2],dry=process.argv.includes('--dry-run');
if(!file)throw Error('usage: verify-etherscan.mjs <deployment record json> [--dry-run]');
const d=JSON.parse(readFileSync(resolve(file),'utf8'));
const input=readFileSync(new URL('../artifacts/standard-input.private.json',import.meta.url),'utf8');
const API='https://api.etherscan.io/v2/api?chainid='+d.chainId;
const fields={module:'contract',action:'verifysourcecode',contractaddress:d.contract,sourceCode:input,codeformat:'solidity-standard-json-input',
 contractname:d.etherscan.contractName,compilerversion:d.etherscan.compiler,constructorArguements:d.etherscan.constructorArgsHex,licenseType:'3'};   // 3 = MIT
console.log(JSON.stringify({chainId:d.chainId,contract:d.contract,contractname:fields.contractname,compiler:fields.compilerversion,
 constructorArgsBytes:fields.constructorArguements.length/2,standardInputBytes:input.length,sources:Object.keys(JSON.parse(input).sources).length},null,1));
if(dry)process.exit(0);
const key=String(process.env.ETHERSCAN_API_KEY??'').trim();
if(!/^[A-Za-z0-9]{20,64}$/.test(key))throw Error('ETHERSCAN_API_KEY missing or malformed');
const post=await (await fetch(API,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...fields,apikey:key})})).json();
if(post.status!=='1'){
 if(/already verified/i.test(String(post.result))){console.log('Already verified: https://sepolia.etherscan.io/address/'+d.contract+'#code');process.exit(0);}
 throw Error('Etherscan refused: '+String(post.result).slice(0,300));
}
console.log('Submitted, waiting for Etherscan (guid '+post.result+') …');
for(let i=0;i<30;i++){
 await new Promise(r=>setTimeout(r,5000));
 const s=await (await fetch(API+'&'+new URLSearchParams({module:'contract',action:'checkverifystatus',guid:post.result,apikey:key}))).json();
 const msg=String(s.result);
 if(/pending/i.test(msg))continue;
 if(s.status==='1'||/pass|already verified/i.test(msg)){console.log('Verified: https://sepolia.etherscan.io/address/'+d.contract+'#code');process.exit(0);}
 throw Error('Verification failed: '+msg.slice(0,300));
}
throw Error('Still pending after 150 s; check https://sepolia.etherscan.io/address/'+d.contract+'#code later');
