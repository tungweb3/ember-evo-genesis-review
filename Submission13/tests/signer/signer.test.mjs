import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {harness,TX,REVEAL_CHAIN} from '../../contract/tests/hardening-harness.mjs';
import {testAuthority,ethers} from '../../contract/tools/runtime.mjs';
import {revealChain,readyReveals} from '../reveal-chain.mjs';
import {CATALOGUE,lookIdentity,canonicalLook,normalizeLook,ruleViolations,ruleWarnings,LookError} from '../look.mjs';
import {FreeApprovalSigner,snapshotTree,ApprovalError} from '../free-approval.mjs';
import {createHandler} from '../worker.mjs';
import {loadPageData,buildCatalogue} from '../tools/gen-catalogue.mjs';

const PAGE=fileURLToPath(new URL('../../../../mint-page/',import.meta.url));
const BASE='ipfs://LOCAL_ONLY_TEST/';
const look=(o={})=>({body:'standard',hat:null,top:'TOP_TEE.ss_crew',vest:null,outer:null,bottom:'BOTTOM_TROUSER.straight_full',shoes:null,eyewear:null,neck:null,belt:null,strap:null,...o});
const code=async(p,c)=>{await assert.rejects(p,e=>{assert.equal(e.code,c);return true;});};

test('catalogue matches the mint page data (no drift), accessories included in their four slots',()=>{
 assert.deepEqual(buildCatalogue(loadPageData(PAGE)),CATALOGUE);
 const all=Object.values(CATALOGUE.slots).flat();
 assert.equal(all.length,330);   // 125 parts + 205 colourways (2026-10-25: the red-stitch cap-toe ankle boot BOOT_LACE_ANKLE.captoe_redstitch, one colour, no colourway) (2026-10-25: the 52 yukata wrap top too) (2026-10-25: the four finished tops 35, 51, banded shirt, colour-block tunic, one colourway each) (2026-10-25: the half-rim glasses and the monocle, 3 colours each) (2026-10-25: the necktie, one colourway) (2026-10-25: the suit trousers and the blazer v001 in white and red) (2026-10-24: the red-band fedora, the piped suit trousers and the piped blazer v001, one colourway each) (2026-10-24: the cat-eye glasses with 2 colourways) (2026-10-24: the square and the aviator sunglasses with 2 colourways each) (2026-10-24: the round sunglasses with 2 colourways) (2026-10-24: the rolled-sleeve henley long sleeve v002 with 2 colourways) (2026-10-24: thin round glasses removed by the owner, bold round glasses added with silver / black / tortoise) (2026-10-24: +31 colours: 12 tops, 7 trousers, 12 accessories; +38 colours: 9 hats, 6 vests, 14 jackets, 9 shoes; +78 second colours) (owner 2026-10-23: styles 9, 17, 24, 27, 55, 46 added, then the cape, the padded vest, the slip-on and (2026-10-24) the harem trousers, the ankle-strap sandals, the asym vest and the button capelet)
 // accessories are part of the look again (owner 2026-10-22): eyewear 2 (+2 frames), neck 3, belt 2 (+1 colour), strap 1
 assert.deepEqual(['eyewear','neck','belt','strap'].map(s=>CATALOGUE.slots[s].length),[25,13,8,3]);   // parts + colourways (2026-10-25: half-rim glasses and monocle +6: eyewear 8 parts + 17 colourways; the necktie, neck 4 + 9) (2026-10-24): eyewear 6 parts + 13 colourways, neck 3 + 9, belt 2 + 6, strap 1 + 2
 assert.ok(CATALOGUE.slots.eyewear.every(id=>id.startsWith('GLASSES.')));
 // 86 parts plus 25 colourways (17 delivered, 8 recoloured for whole styles) ("<part>@<code>"), each listed with its part and carrying its part's rules
 const cw=all.filter(id=>id.includes('@'));assert.equal(cw.length,205);
 // style 3's robe + mantle is one combined jacket with both pieces' rules (covers the top, one-piece, cape)
 assert.ok(CATALOGUE.slots.outer.includes('ROBE.open_ankle_bell_mantle'));
 assert.deepEqual(CATALOGUE.occupies['ROBE.open_ankle_bell_mantle'],['top','outerwear','cape']);assert.deepEqual(CATALOGUE.flags['ROBE.open_ankle_bell_mantle'],['onepiece','cape']);
 for(const id of cw){const p=id.split('@')[0];
  assert.ok(Object.values(CATALOGUE.slots).some(ids=>ids.includes(p)&&ids.includes(id)));
  assert.deepEqual(CATALOGUE.occupies[id],CATALOGUE.occupies[p]);assert.deepEqual(CATALOGUE.flags[id],CATALOGUE.flags[p]);
  assert.equal(CATALOGUE.noLayerOver.includes(id),CATALOGUE.noLayerOver.includes(p));}
});

test('look rules (owner 2026-10-26): only trousers under a coverall / diving suit refuse; the other rules warn and still sign',()=>{
 assert.throws(()=>lookIdentity(look({top:null,outer:'COVERALL.work'})),e=>e instanceof LookError&&e.code==='LOOK_RULE_OUTER_COVERS_BOTTOM');
 lookIdentity(look({top:null,bottom:null,outer:'COVERALL.work'}));
 const cases=[
  [{outer:'ANORAK.hood_down_ss'},'OUTER_COVERS_TOP'],
  [{outer:'COAT_TAIL.classic_tails'},'TAILCOAT_NEEDS_VEST'],
  [{top:null,bottom:null,outer:'ROBE.closed_midcalf_shawl',vest:'VEST_TAILORED.double_breasted_short'},'VEST_WITH_ONEPIECE'],
  [{bottom:'BIB_OVERALL.long_cross_back',vest:'VEST_TAILORED.double_breasted_short'},'VEST_WITH_BIB'],
  [{top:'COLLAR_INSERT.crew_rib'},'COLLAR_NEEDS_JACKET'],
  [{top:'TOP_WRAP.ls_hip_sash',vest:'VEST_TAILORED.double_breasted_short'},'TOP_CANNOT_BE_LAYERED'],
  [{bottom:null,strap:'STRAP_SUSPENDERS.y_back_over_vest'},'STRAP_NEEDS_TROUSERS']];
 for(const [o,rule] of cases){assert.ok(ruleWarnings(normalizeLook(look(o))).includes(rule),rule);lookIdentity(look(o));}
 // the usual versions carry no warning
 assert.deepEqual(ruleWarnings(normalizeLook(look({top:'COLLAR_INSERT.crew_rib',outer:'JACKET_HIP_LS.field_4pocket'}))),[]);
 assert.deepEqual(ruleWarnings(normalizeLook(look({outer:'COAT_TAIL.classic_tails',vest:'VEST_TAILORED.double_breasted_short'}))),[]);
});

test('look validation: exact fields, parts only in their own slot, null and empty string are the same look',()=>{
 assert.throws(()=>lookIdentity({...look(),skin:'green'}),{code:'LOOK_FIELDS_INVALID'});
 assert.throws(()=>lookIdentity({...look(),acc:null}),{code:'LOOK_FIELDS_INVALID'});
 const {shoes,...missing}=look();assert.throws(()=>lookIdentity(missing),{code:'LOOK_FIELDS_INVALID'});
 assert.throws(()=>lookIdentity(look({hat:'TOP_TEE.ss_crew'})),{code:'PART_UNKNOWN'});
 assert.throws(()=>lookIdentity(look({hat:'GLASSES.round_bold'})),{code:'PART_UNKNOWN'});
 assert.throws(()=>lookIdentity(look({body:'giant'})),{code:'BODY_UNKNOWN'});
 // two body types since 2026-10-22: the elder body is no longer part of the collection
 assert.deepEqual(CATALOGUE.bodies,['standard','stocky']);
 assert.throws(()=>lookIdentity(look({body:'elder'})),{code:'BODY_UNKNOWN'});
 assert.equal(lookIdentity(look({hat:''})).lookKey,lookIdentity(look({hat:null})).lookKey);
 assert.notEqual(lookIdentity(look({body:'stocky'})).lookKey,lookIdentity(look()).lookKey);
 // a colourway is a different look from its part in the catalogue colour
 assert.notEqual(lookIdentity(look({bottom:'BOTTOM_TROUSER.straight_full@C18'})).lookKey,lookIdentity(look()).lookKey);
 assert.throws(()=>lookIdentity(look({bottom:'BOTTOM_TROUSER.straight_full@C99'})),{code:'PART_UNKNOWN'});
 assert.equal(canonicalLook(normalizeLook(look())),'emberevo-genesis-look:v2;body=standard;hat=none;top=TOP_TEE.ss_crew;vest=none;outer=none;bottom=BOTTOM_TROUSER.straight_full;shoes=none;eyewear=none;neck=none;belt=none;strap=none');
 // accessories change the look; glasses go only in eyewear; suspenders need trousers (not bib overalls)
 assert.notEqual(lookIdentity(look({eyewear:'GLASSES.round_bold'})).lookKey,lookIdentity(look()).lookKey);
 assert.throws(()=>lookIdentity(look({neck:'GLASSES.round_bold'})),{code:'PART_UNKNOWN'});
 lookIdentity(look({strap:'STRAP_SUSPENDERS.y_back_over_vest'}));
 // suspenders without trousers or over bib overalls only warn since 2026-10-26
 assert.ok(ruleWarnings(normalizeLook(look({strap:'STRAP_SUSPENDERS.y_back_over_vest',bottom:null}))).includes('STRAP_NEEDS_TROUSERS'));
 assert.ok(ruleWarnings(normalizeLook(look({strap:'STRAP_SUSPENDERS.y_back_over_vest',bottom:'BIB_OVERALL.long_cross_back'}))).includes('STRAP_NEEDS_TROUSERS'));
});

async function setup(){
 const h=await harness();
 const carol=await h.provider.getSigner(3),c=await carol.getAddress();
 const wallets=[h.a,h.b,c],tree=snapshotTree(wallets);
 const now=Number((await h.provider.getBlock('latest')).timestamp);
 await h.mine(h.contract.configureSnapshot(tree.root,wallets.length,now-1,now+20,TX));
 // the reveal base must equal the signer's metadata base (as on the real deployment): a chosen token's URI is derived from it.
 // Opening needs the locked URIs and the reveal commitment first (2026-10-27).
 await h.mine(h.contract.setRevealURIs('ipfs://LOCAL_ONLY_TEST/pending',BASE,true,TX));
 await h.commit(REVEAL_CHAIN.anchor);
 await h.mine(h.contract.setMintPaused(false,TX));
 await h.rpc.request({method:'evm_increaseTime',params:[21]});await h.rpc.request({method:'evm_mine',params:[]});
 const opts={provider:h.provider,contractAddress:h.contract.target,chainId:31337,signer:h.approvalSigner,metadataBase:BASE,snapshotWallets:wallets};
 return {h,carol,c,wallets,opts,signer:new FreeApprovalSigner(opts)};
}
const send=(h,who,m)=>h.mine(h.contract.connect(who).mintFree(m.lookKey,m.choice,m.uri,m.deadline,m.signature,m.index,m.proof,TX));
/** Dry run of the same call, so a refusal comes back with its revert reason. */
const call=(h,who,m)=>h.contract.connect(who).mintFree.staticCall(m.lookKey,m.choice,m.uri,m.deadline,m.signature,m.index,m.proof);

test('end to end: a signed free approval mints on the R5 contract; the contract keeps every binding',async()=>{
 const {h,carol,c,signer}=await setup();try{
  const A=await signer.approve({wallet:h.a,look:look(),choice:0});
  assert.equal(A.mintFree.uri,BASE+A.mintFree.lookKey+'/0');
  // another wallet cannot use alice's packet
  await assert.rejects(call(h,h.bob,A.mintFree),/APPEARANCE_AUTHORITY/);
  // a changed choice or uri breaks the signature
  await assert.rejects(call(h,h.alice,{...A.mintFree,choice:1,uri:BASE+A.mintFree.lookKey+'/1'}),/APPEARANCE_AUTHORITY/);
  const rc=await send(h,h.alice,A.mintFree);assert.equal(rc.status,1);
  assert.equal(await h.contract.tokenURI(1),A.mintFree.uri);assert.equal((await h.contract.tokenLook(1)).lookKey,A.mintFree.lookKey);
  await code(signer.approve({wallet:h.a,look:look({body:'stocky'}),choice:0}),'FREE_ALREADY_CLAIMED');
  // R6: looks may repeat: the look alice took in green is still signed for others, in green, ice blue and random
  await signer.approve({wallet:h.b,look:look(),choice:0});
  await signer.approve({wallet:h.b,look:look(),choice:1});
  await signer.approve({wallet:h.b,look:look(),choice:3});
  // random: empty uri, mints pending
  const B=await signer.approve({wallet:h.b,look:look({hat:'HAT_BERET.beret'}),choice:3});
  assert.equal(B.mintFree.uri,'');await send(h,h.bob,B.mintFree);
  assert.equal(await h.contract.tokenURI(2),'ipfs://LOCAL_ONLY_TEST/pending');
  // and a look minted as random can still be picked directly
  await signer.approve({wallet:c,look:look({hat:'HAT_BERET.beret'}),choice:2});
  // pink/orange/gold cannot be chosen; not on the list -> refused
  await code(signer.approve({wallet:c,look:look(),choice:4}),'CHOICE_INVALID');
  await code(signer.approve({wallet:await h.admin.getAddress(),look:look(),choice:1}),'NOT_IN_SNAPSHOT');
  // an expired approval is refused by the contract
  const C=await signer.approve({wallet:c,look:look({shoes:'SNEAKER.low'}),choice:2});
  await h.rpc.request({method:'evm_increaseTime',params:[301]});await h.rpc.request({method:'evm_mine',params:[]});
  await assert.rejects(call(h,carol,C.mintFree),/APPEARANCE_EXPIRED/);
  const C2=await signer.approve({wallet:c,look:look({shoes:'SNEAKER.low'}),choice:2});await send(h,carol,C2.mintFree);
  assert.equal(await h.contract.freeMinted(),3n);
 }finally{await h.close();}
});

test('the signer refuses when it is not the active signer, the list does not match the root, or mint is paused',async()=>{
 const {h,opts,signer}=await setup();try{
  await code(new FreeApprovalSigner({...opts,signer:testAuthority(1)}).approve({wallet:h.a,look:look(),choice:0}),'SIGNER_NOT_ACTIVE');
  await code(new FreeApprovalSigner({...opts,snapshotWallets:[h.a,h.b]}).approve({wallet:h.a,look:look(),choice:0}),'SNAPSHOT_MISMATCH');
  await h.mine(h.contract.setMintPaused(true,TX));
  await code(signer.approve({wallet:h.a,look:look(),choice:0}),'MINT_PAUSED');
  assert.throws(()=>new FreeApprovalSigner({...opts,metadataBase:'ipfs://x'}),{code:'CONFIG_METADATA_BASE'});
 }finally{await h.close();}
});

test('worker: origin allow-list, content type, size limit, paid route closed, errors carry codes only',async()=>{
 const {h,signer}=await setup();try{
  const ORIGIN='https://mint.example.test',fetch=createHandler({approver:async()=>signer,allowedOrigins:[ORIGIN]});
  const post=(body,headers={},path='/v1/approval/free')=>fetch(new Request('https://signer.example.test'+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:ORIGIN,...headers},body}));
  const j=async r=>({status:r.status,body:await r.json(),acao:r.headers.get('Access-Control-Allow-Origin')});
  const ok=await j(await post(JSON.stringify({wallet:h.a,look:look(),choice:1})));
  assert.equal(ok.status,200);assert.equal(ok.acao,ORIGIN);assert.equal(ok.body.mintFree.choice,1);assert.match(ok.body.mintFree.signature,/^0x[0-9a-f]{130}$/);
  assert.equal((await j(await post('{}',{Origin:'https://evil.example'}))).status,403);
  assert.equal((await j(await post('{}',{'Content-Type':'text/plain'}))).status,415);
  assert.equal((await j(await post('x'.repeat(5000)))).status,413);
  assert.equal((await j(await post('{bad'))).body.error.code,'REQUEST_JSON_INVALID');
  assert.deepEqual((await j(await post(JSON.stringify({wallet:h.a,look:look({top:null,outer:'COVERALL.work'}),choice:0})))).body,{ok:false,error:{code:'LOOK_RULE_OUTER_COVERS_BOTTOM'}});
  assert.equal((await j(await post('{}',{},'/v1/approval/paid'))).body.error.code,'PAID_ROUTE_NOT_READY');
  const pre=await fetch(new Request('https://signer.example.test/v1/approval/free',{method:'OPTIONS',headers:{Origin:ORIGIN}}));assert.equal(pre.status,204);
  const health=await j(await fetch(new Request('https://signer.example.test/v1/health')));assert.equal(health.body.catalogueVersion,CATALOGUE.version);
  // unexpected failures do not leak details
  const broken=createHandler({approver:async()=>({approve:async()=>{throw Error('rpc down at https://secret-rpc')}}),allowedOrigins:[ORIGIN]});
  const r=await broken(new Request('https://signer.example.test/v1/approval/free',{method:'POST',headers:{'Content-Type':'application/json',Origin:ORIGIN},body:'{}'}));
  assert.deepEqual(await r.json(),{ok:false,error:{code:'INTERNAL_ERROR'}});
 }finally{await h.close();}
});

test('the mint page uses byte-identical copies of the shared rules (run tools/sync-page.mjs after a change)',async()=>{
 const {readFileSync}=await import('node:fs');const {SHARED}=await import('../tools/sync-page.mjs');
 for(const [from,to] of SHARED)assert.ok(readFileSync(new URL('../../'+from,import.meta.url)).equals(readFileSync(PAGE+to)),to);
});

test('eligibility: on the list or not, and claimed after a free mint',async()=>{
 const {h,signer}=await setup();try{
  assert.deepEqual(await signer.eligibility({wallet:h.a}),{wallet:h.a,eligible:true,freeClaimed:false});
  assert.equal((await signer.eligibility({wallet:await h.admin.getAddress()})).eligible,false);
  const A=await signer.approve({wallet:h.a,look:look(),choice:0});await send(h,h.alice,A.mintFree);
  assert.equal((await signer.eligibility({wallet:h.a})).freeClaimed,true);
  await code(signer.eligibility({wallet:h.a,extra:1}),'REQUEST_FIELDS_INVALID');
 }finally{await h.close();}
});

test('worker: an approval records its look, GET /v1/look/<lookKey> gives the outfit back (owner 2026-10-26)',async()=>{
 const {h,signer}=await setup();try{
  const ORIGIN='https://mint.example.test',fetch=createHandler({approver:async()=>signer,allowedOrigins:[ORIGIN]});
  const kv=new Map(),LOOKS={get:async k=>kv.get(k)??null,put:async(k,v)=>{kv.set(k,v);}};
  const post=env=>fetch(new Request('https://signer.example.test/v1/approval/free',{method:'POST',headers:{'Content-Type':'application/json',Origin:ORIGIN},
   body:JSON.stringify({wallet:h.a,look:look({hat:'HAT_BERET.beret',body:'stocky'}),choice:1})}),env);
  const get=(key,env={LOOKS})=>fetch(new Request('https://signer.example.test/v1/look/'+key,{headers:{Origin:ORIGIN}}),env);
  const A=await (await post({LOOKS})).json();
  assert.equal(kv.size,1);assert.equal(kv.get(A.mintFree.lookKey),A.canonical);
  const r=await get(A.mintFree.lookKey);assert.equal(r.headers.get('Access-Control-Allow-Origin'),ORIGIN);
  const got=await r.json();
  assert.deepEqual(got,{ok:true,lookKey:A.mintFree.lookKey,canonical:A.canonical,look:normalizeLook(look({hat:'HAT_BERET.beret',body:'stocky'}))});
  assert.equal(lookIdentity(got.look).lookKey,A.mintFree.lookKey);
  // unknown, malformed, tampered, or no store
  assert.equal((await (await get('0x'+'0'.repeat(64))).json()).error.code,'LOOK_NOT_FOUND');
  assert.equal((await (await get('0x12')).json()).error.code,'LOOK_KEY_INVALID');
  kv.set('0x'+'1'.repeat(64),A.canonical);assert.equal((await (await get('0x'+'1'.repeat(64))).json()).error.code,'LOOK_NOT_FOUND');
  assert.equal((await get(A.mintFree.lookKey,{})).status,501);
  // the approval is not handed out when the look cannot be recorded
  const down={get:async()=>null,put:async()=>{throw Error('kv down');}};
  const refused=await post({LOOKS:down});assert.equal(refused.status,503);assert.equal((await refused.json()).error.code,'LOOK_STORE_UNAVAILABLE');
  // a look already stored is not written again; a refused write of a look a concurrent request just stored still succeeds
  let puts=0;const counted={get:LOOKS.get,put:async(k,v)=>{puts++;kv.set(k,v);}};
  assert.equal((await post({LOOKS:counted})).status,200);assert.equal(puts,0);
  let first=true;const racing={get:async k=>first?(first=false,null):kv.get(k)??null,put:async()=>{throw Error('429 too many writes to the same key');}};
  assert.equal((await post({LOOKS:racing})).status,200);
 }finally{await h.close();}
});

test('worker: GET /v1/reveals hands out a secret only once its epoch seed block is mined and 2 blocks deep, and the mint carries it',async()=>{
 const {h,signer}=await setup();try{
  const ORIGIN='https://mint.example.test',ready=()=>readyReveals({provider:h.provider,contractAddress:h.contract.target,chain:REVEAL_CHAIN,hashWindow:256});
  const fetch=createHandler({approver:async()=>signer,reveals:async()=>ready,allowedOrigins:[ORIGIN]});
  const get=(env={})=>fetch(new Request('https://signer.example.test/v1/reveals',{headers:{Origin:ORIGIN}}),env);
  assert.deepEqual((await (await get()).json()).reveals,[]);
  // a random mint opens an epoch; until its seed block is mined the secret stays with the signer
  const R=await signer.approve({wallet:h.a,look:look(),choice:3});
  await h.mine(h.contract.connect(h.alice).mintFree(R.mintFree.lookKey,3,R.mintFree.uri,R.mintFree.deadline,R.mintFree.signature,R.mintFree.index,R.mintFree.proof,[],TX));
  const ep=(await h.epochOf(1)),sb=Number(await h.contract.epochSeedBlock(ep));
  assert.deepEqual((await (await get()).json()).reveals,[]);
  while(await h.provider.getBlockNumber()<sb)await h.rpc.request({method:'evm_mine',params:[]});
  // audit 2026-10-27 finding 4: the seed block itself, or one block on top, could still be replaced by a reorg
  assert.deepEqual((await (await get()).json()).reveals,[]);
  await h.rpc.request({method:'evm_mine',params:[]});assert.deepEqual((await (await get()).json()).reveals,[]);
  await h.rpc.request({method:'evm_mine',params:[]});
  const body=await (await get()).json();assert.deepEqual(body.reveals,[REVEAL_CHAIN.secret(1)]);assert.equal(body.block,sb+2);
  // the next mint must carry it: without it REVEAL_PENDING, with it the epoch is sealed and revealed first
  const B=await signer.approve({wallet:h.b,look:look(),choice:0});
  await assert.rejects(h.contract.connect(h.bob).mintFree.staticCall(B.mintFree.lookKey,0,B.mintFree.uri,B.mintFree.deadline,B.mintFree.signature,B.mintFree.index,B.mintFree.proof,[]),/REVEAL_PENDING/);
  await h.mine(h.contract.connect(h.bob).mintFree(B.mintFree.lookKey,0,B.mintFree.uri,B.mintFree.deadline,B.mintFree.signature,B.mintFree.index,B.mintFree.proof,body.reveals,TX));
  assert.equal((await h.contract.skinOf(1))[1],true);assert.deepEqual((await (await get()).json()).reveals,[]);
  // no seed: 501; a seed whose chain is not the contract's: 503 with a code only; rate limited: 429
  assert.equal((await createHandler({approver:async()=>signer,allowedOrigins:[ORIGIN]})(new Request('https://signer.example.test/v1/reveals'))).status,501);
  const C=await signer.approve({wallet:(await h.provider.getSigner(3)).address,look:look(),choice:3});
  await h.mine(h.contract.connect(await h.provider.getSigner(3)).mintFree(C.mintFree.lookKey,3,C.mintFree.uri,C.mintFree.deadline,C.mintFree.signature,C.mintFree.index,C.mintFree.proof,[],TX));
  const sb2=Number(await h.contract.epochSeedBlock((await h.epochOf(3))));
  while(await h.provider.getBlockNumber()<sb2+2)await h.rpc.request({method:'evm_mine',params:[]});
  const other=revealChain(ethers.keccak256(ethers.toUtf8Bytes('another seed')),16);
  const wrong=createHandler({approver:async()=>signer,reveals:async()=>()=>readyReveals({provider:h.provider,contractAddress:h.contract.target,chain:other}),allowedOrigins:[ORIGIN]});
  const w=await wrong(new Request('https://signer.example.test/v1/reveals',{headers:{Origin:ORIGIN}}));
  assert.equal(w.status,503);assert.deepEqual(await w.json(),{ok:false,error:{code:'REVEAL_CHAIN_MISMATCH'}});
  assert.equal((await get({RATE_LIMITER:{limit:async()=>({success:false})}})).status,429);
 }finally{await h.close();}
});

test('worker: GET /v1/stats reports the minted count from the chain',async()=>{
 const {h,signer}=await setup();try{
  const fetch=createHandler({approver:async()=>signer,allowedOrigins:['https://mint.example.test']});
  const get=async()=>(await fetch(new Request('https://signer.example.test/v1/stats'))).json();
  assert.deepEqual(await get(),{ok:true,totalMinted:0,maxSupply:1688});
  const A=await signer.approve({wallet:h.a,look:look(),choice:0});await send(h,h.alice,A.mintFree);
  assert.equal((await get()).totalMinted,1);
 }finally{await h.close();}
});

test('free mixing (owner 2026-10-26): no part pair is refused; the old clipping pairs and the needs-a-top parts are page warnings',()=>{
 const all=Object.values(CATALOGUE.slots).flat();
 assert.deepEqual(CATALOGUE.incompatible,[]);assert.ok(CATALOGUE.needsTop.length>0);
 const base={body:'standard',hat:null,top:null,vest:null,outer:null,bottom:null,shoes:null,eyewear:null,neck:null,belt:null,strap:null};
 const cape='CAPE_SHOULDER.cape_striped_hip',vest='VEST_PADDED.quilted',crew='TOP_TEE.ss_crew',blazer='JACKET_HIP_LS.blazer_2btn_piped';
 // the pairs the hand policies used to refuse are page warnings now (flag 'hand'), and they sign
 const soft=loadPageData(PAGE).rules.softClip;
 assert.ok(soft.some(([a,b,f])=>f==='hand'&&[a,b].includes(cape)&&[a,b].includes(crew)));
 assert.deepEqual(ruleViolations({...base,outer:cape,top:crew}),[]);
 assert.deepEqual(ruleViolations({...base,bottom:'BOTTOM_TROUSER.harem',shoes:'SNEAKER.low'}),[]);
 // needs a top: a warning; an inner collar still counts as the cover only for the blazer
 assert.deepEqual(CATALOGUE.collarCoversTop,[blazer]);
 assert.ok(ruleWarnings({...base,outer:cape}).includes('NEEDS_TOP'));assert.deepEqual(ruleViolations({...base,outer:cape}),[]);
 assert.ok(!ruleWarnings({...base,outer:blazer,top:'COLLAR_INSERT.shirt_fold'}).includes('NEEDS_TOP'));
 assert.ok(ruleWarnings({...base,outer:blazer,vest,top:'COLLAR_INSERT.shirt_fold'}).includes('NEEDS_TOP'));
 // the engine still refuses a pair if one is listed again
 assert.deepEqual(ruleViolations({...base,outer:cape,top:crew},{...CATALOGUE,incompatible:[[cape,crew]]}),['PARTS_CLIP']);
 assert.ok(all.includes(cape));
});

test('pairwise clipping (owner 2026-10-26): every measured pair is a page warning, none is refused; the whole-outfits tab is gone',async()=>{
 const {readFileSync}=await import('node:fs');
 const soft=loadPageData(PAGE).rules.softClip;
 assert.ok(soft.length>1000,'pairwise block + warn + hand pairs are all warnings');
 assert.ok(soft.some(([a,b])=>[a,b].sort().join('|')===['BELT_LEATHER.wide_buckle','TOP_TEE.ss_crew'].sort().join('|')));
 const base={body:'standard',hat:null,top:null,vest:null,outer:null,bottom:null,shoes:null,eyewear:null,neck:null,belt:null,strap:null};
 assert.deepEqual(ruleViolations({...base,belt:'BELT_LEATHER.wide_buckle',top:'TOP_TEE.ss_crew'}),[]);
 assert.ok(!/styles-data\.js/.test(readFileSync(PAGE+'index.html','utf8')),'the page must not load the whole-outfits data');
});

test('free mixing before 2026-10-26 (kept for the record, not run)',{skip:'owner 2026-10-26: these pairs warn now'},()=>{
 const all=Object.values(CATALOGUE.slots).flat();
 assert.ok(CATALOGUE.incompatible.length>0&&CATALOGUE.needsTop.length>0);
 const base={body:'standard',hat:null,top:null,vest:null,outer:null,bottom:null,shoes:null,eyewear:null,neck:null,belt:null,strap:null};
 const cape='CAPE_SHOULDER.cape_striped_hip',vest='VEST_PADDED.quilted',tucked='TOP_TEE.ss_crew_tucked',crew='TOP_TEE.ss_crew';
 assert.ok(all.includes(cape)&&all.includes(vest));
 // every listed pair really is refused when both parts are worn (in the slots they belong to)
 const slotOf=id=>Object.keys(CATALOGUE.slots).find(s=>CATALOGUE.slots[s].includes(id));
 for(const [a,b] of CATALOGUE.incompatible){
  const sa=slotOf(a),sb=slotOf(b);
  if(sa===sb)continue;                                   // two parts of one slot can never be worn together anyway
  assert.ok(ruleViolations({...base,[sa]:a,[sb]:b}).includes('PARTS_CLIP'),`${a} + ${b} must be refused`);
 }
 // a cape alone leaves the torso bare; with the tucked tee it is fine; with another tee it clips; a collar insert is not a torso cover
 assert.ok(ruleViolations({...base,outer:cape}).includes('NEEDS_TOP'));
 assert.ok(!ruleViolations({...base,outer:cape,top:tucked}).length);
 assert.ok(ruleViolations({...base,outer:cape,top:crew}).includes('PARTS_CLIP'));
 assert.ok(ruleViolations({...base,outer:cape,top:'COLLAR_INSERT.crew_rib'}).includes('NEEDS_TOP'));
 // owner 2026-10-26: the blazer is the one needsTop part an inner collar can satisfy (check F09: 20 of 21 test cells covered); every other one still needs a real top
 const blazer='JACKET_HIP_LS.blazer_2btn_piped';
 assert.deepEqual(CATALOGUE.collarCoversTop,[blazer]);
 assert.ok(ruleViolations({...base,outer:blazer}).includes('NEEDS_TOP'));
 const inserts=all.filter(id=>id.startsWith('COLLAR_INSERT.')&&!id.includes('@'));
 assert.ok(inserts.length>=5);
 for(const c of inserts)assert.ok(!ruleViolations({...base,outer:blazer,top:c}).includes('NEEDS_TOP'),`blazer + ${c} must satisfy the top rule`);
 assert.ok(ruleViolations({...base,outer:blazer,vest,top:'COLLAR_INSERT.shirt_fold'}).includes('NEEDS_TOP'));   // the padded vest still needs a real top
 assert.ok(ruleViolations({...base,top:'COLLAR_INSERT.shirt_fold'}).includes('COLLAR_NEEDS_JACKET'));          // an inner collar still needs a jacket
 // the padded vest needs a top, and the hem-out crew tee clips with it; a colourway of a listed part is refused too
 assert.ok(ruleViolations({...base,vest}).includes('NEEDS_TOP'));
 assert.ok(ruleViolations({...base,vest,top:crew}).includes('PARTS_CLIP'));
 assert.ok(!ruleViolations({...base,vest,top:tucked}).length);
 const crewColour=all.find(id=>id.startsWith(crew+'@'));
 if(crewColour)assert.ok(ruleViolations({...base,vest,top:crewColour}).includes('PARTS_CLIP'));
 // in-boot trousers only with the rubber boot
 const inboot='BOTTOM_TROUSER.crop_midcalf_in_boot';
 assert.ok(ruleViolations({...base,bottom:inboot,shoes:'SHOE_LOW.loafer'}).includes('PARTS_CLIP'));
 assert.ok(!ruleViolations({...base,bottom:inboot,shoes:'BOOT_RUBBER.midcalf'}).length);
 // harem trousers (check F07/F11): only the slip-on and the loafer clear the cuff; the sneaker is below the ankle so it is blocked by name
 const harem='BOTTOM_TROUSER.harem';
 assert.ok(all.includes(harem));
 for(const ok of ['SHOE_LOW.cloth_slipon','SHOE_LOW.loafer'])assert.ok(!ruleViolations({...base,bottom:harem,shoes:ok}).length,`harem + ${ok} must be allowed`);
 for(const bad of ['SNEAKER.low','SHOE_LOW.oxford_lace','BOOT_PLAIN_ANKLE.plain','BOOT_RUBBER.midcalf'])assert.ok(ruleViolations({...base,bottom:harem,shoes:bad}).includes('PARTS_CLIP'),`harem + ${bad} must be refused`);
 // the engine itself, on a small catalogue: no pair listed, no refusal
 assert.deepEqual(ruleViolations({...base,outer:cape,top:crew},{...CATALOGUE,incompatible:[],needsTop:[]}),[]);
});

test('pairwise clipping decision (owner 2026-10-24, kept for the record, not run)',{skip:'owner 2026-10-26: the obvious pairs warn now'},async()=>{
 const {readFileSync}=await import('node:fs');
 const soft=loadPageData(PAGE).rules.softClip;
 assert.ok(soft.length>300&&CATALOGUE.incompatible.length>300,'both lists are filled from pairwise-pairs.json');
 const refused=new Set(CATALOGUE.incompatible.map(p=>[...p].sort().join('|')));
 const slotOf=id=>Object.keys(CATALOGUE.slots).find(s=>CATALOGUE.slots[s].includes(id));
 const base={body:'standard',hat:null,top:null,vest:null,outer:null,bottom:null,shoes:null,eyewear:null,neck:null,belt:null,strap:null};
 for(const [a,b,why] of soft){
  assert.ok(!refused.has([a,b].sort().join('|')),`${a} + ${b} (${why}) is only a page warning, it must not be in the refused list`);
  const sa=slotOf(a),sb=slotOf(b);
  if(sa&&sb&&sa!==sb)assert.ok(!ruleViolations({...base,[sa]:a,[sb]:b}).includes('PARTS_CLIP'),`${a} + ${b} must not be refused`);
 }
 // owner 2026-10-24 removed the whole-outfits tab: the page no longer loads the styles, so the two pairs that used to be kept as warnings for styles 11 and 41
 // (wide buckle belt + crew tee, rubber boot + diving suit) are refused like every other obvious pair
 assert.ok(!/styles-data\.js/.test(readFileSync(PAGE+'index.html','utf8')),'the page must not load the whole-outfits data');
 assert.ok(refused.has(['BELT_LEATHER.wide_buckle','TOP_TEE.ss_crew'].sort().join('|')));
 assert.ok(refused.has(['BOOT_RUBBER.midcalf','SUIT_DIVER.diver'].sort().join('|')));
 assert.ok(ruleViolations({...base,belt:'BELT_LEATHER.wide_buckle',top:'TOP_TEE.ss_crew'}).includes('PARTS_CLIP'));
});

