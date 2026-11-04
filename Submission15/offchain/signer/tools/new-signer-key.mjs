// Creates a fresh approval-signer key for a rehearsal. The key is written to a file in your home folder (never printed);
// only the address is printed. Put the key into the Worker with: wrangler secret put SIGNER_PRIVATE_KEY
// Usage: node signer/tools/new-signer-key.mjs <label>     e.g.  node signer/tools/new-signer-key.mjs sepolia
import {writeFileSync,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {Wallet} from '../../vendor/ethers.min.js';

const label=process.argv[2];
if(!label||!/^[a-z0-9-]{1,32}$/.test(label))throw Error('usage: new-signer-key.mjs <label: a-z 0-9 ->');
const file=join(homedir(),`genesis-signer-${label}.key`);
if(existsSync(file))throw Error('already exists, not overwritten: '+file);
const w=Wallet.createRandom();
writeFileSync(file,w.privateKey+'\n',{mode:0o600,flag:'wx'});
console.log(JSON.stringify({signerAddress:w.address,keyFile:file}));
