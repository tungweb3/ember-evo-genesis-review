// Creates the reveal seed for a deployment. The seed is written to a file in your home folder (never printed); only the
// chain's anchor is printed, which goes to the contract (deploy env REVEAL_COMMIT, or setRevealCommit while paused).
// Put the seed into the signer Worker with: wrangler secret put REVEAL_SEED
// Usage: node signer/tools/new-reveal-seed.mjs <label>            e.g.  node signer/tools/new-reveal-seed.mjs sepolia
//        node signer/tools/new-reveal-seed.mjs <label> --anchor   prints the anchor of an existing seed file again
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {revealChain,REVEAL_CHAIN_LENGTH} from '../reveal-chain.mjs';

const label=process.argv[2];
if(!label||!/^[a-z0-9-]{1,32}$/.test(label))throw Error('usage: new-reveal-seed.mjs <label: a-z 0-9 -> [--anchor]');
const file=join(homedir(),`genesis-reveal-seed-${label}.key`);
if(process.argv.includes('--anchor')){
 const chain=revealChain(readFileSync(file,'utf8').trim());
 console.log(JSON.stringify({revealCommit:chain.anchor,length:chain.length,seedFile:file}));
}else{
 if(existsSync(file))throw Error('already exists, not overwritten: '+file);
 const seed='0x'+randomBytes(32).toString('hex');
 writeFileSync(file,seed+'\n',{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({revealCommit:revealChain(seed).anchor,length:REVEAL_CHAIN_LENGTH,seedFile:file}));
}
