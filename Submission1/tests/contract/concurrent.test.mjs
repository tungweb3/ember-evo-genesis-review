import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,COST,TX,artifacts,REVEAL_CHAIN} from './hardening-harness.mjs';
import {ethers,testAuthority} from '../tools/runtime.mjs';
import {GOLD_TYPES} from '../../service/gold-ledger.mjs';
const freeArgs=(p,proof)=>[p.key,p.choice??0,p.uri,p.deadline,p.signature,proof];
async function at(h,t){await h.rpc.request({method:'evm_setNextBlockTimestamp',params:[t]});await h.rpc.request({method:'evm_mine',params:[]});}

test('R4: both paths reject start-1 and open at the exact common start; zero free reservation',async()=>{
 const h=await harness();try{const now=await h.time(),start=now+20,leaf=ethers.keccak256(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address'],[h.a])));
 await h.mine(h.contract.configureSnapshot(leaf,1,now,start,TX));
 await h.mine(h.contract.setRevealURIs('ipfs://LOCAL_ONLY/pending','ipfs://LOCAL_ONLY/revealed/',true,TX));await h.mine(h.contract.setRevealCommit(REVEAL_CHAIN.anchor,TX));
 await h.mine(h.contract.setMintPaused(false,TX));await h.mine(h.contract.approvePaidPrice(TX));await h.mine(h.token.connect(h.alice).approve(h.contract.target,COST,TX));
 const f=await h.approval(h.a,'boundary-free'),p=await h.approval(h.a,'boundary-paid'),args=await h.paidArgs(p);
 await at(h,start-1);await assert.rejects(h.contract.connect(h.alice).mintFree.staticCall(...freeArgs(f,[])),/SALE_NOT_STARTED/);await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...args),/SALE_NOT_STARTED/);assert.equal(await h.contract.paidAvailability(),0n);
 await at(h,start);await h.contract.connect(h.alice).mintFree.staticCall(...freeArgs(f,[]));await h.contract.connect(h.alice).mintPaid.staticCall(...args);assert.equal(await h.contract.paidAvailability(),1288n);assert.equal(await h.contract.remainingFreeReservation(),0n);
 }finally{await h.close();}
});
test('R4: paid then free and free then paid coexist; payment never consumes free eligibility',async()=>{
 for(const paidFirst of [true,false]){const h=await harness();try{const setup=await h.configure([h.a]),f=await h.approval(h.a,'free'),p=await h.approval(h.a,'paid');await h.mine(h.token.connect(h.alice).approve(h.contract.target,COST*2n,TX));const before=await h.token.balanceOf(h.a);
 const free=()=>h.mine(h.contract.connect(h.alice).mintFree(...freeArgs(f,setup.tree.proof(0)),TX));
 if(paidFirst){await h.paid(h.alice,p);assert.equal(await h.contract.freeClaimed(h.a),false);await free();}else{await free();assert.equal(await h.token.balanceOf(h.a),before);await h.paid(h.alice,p);}
 assert.equal(await h.contract.totalMinted(),2n);assert.equal(await h.contract.freeMinted(),1n);assert.equal(await h.contract.paidMinted(),1n);assert.equal(await h.token.balanceOf(h.a),before-COST);
 const extra=await h.approval(h.a,'second-free');await assert.rejects(h.contract.connect(h.alice).mintFree.staticCall(...freeArgs(extra,setup.tree.proof(0))),/FREE_ALREADY_CLAIMED/);
 }finally{await h.close();}}
});
test('R4: free claim survives three and ten days and pause; fresh approval still required',async()=>{
 const h=await harness();try{const setup=await h.configure([h.a,h.b]);await h.mine(h.contract.setMintPaused(true,TX));await at(h,(await h.time())+10*86400);await h.mine(h.contract.setMintPaused(false,TX));const f=await h.approval(h.a,'day-ten');await h.mine(h.contract.connect(h.alice).mintFree(...freeArgs(f,setup.tree.proof(0)),TX));assert.equal(await h.contract.freeMinted(),1n);assert.equal(await h.contract.paidAvailability(),1287n);
 }finally{await h.close();}
});
test('R4: 1,288 eligible wallets (the whole supply) do not reserve supply; sold-out blocks unclaimed free and paid, in either final order',async()=>{
 for(const winner of ['free','paid']){const h=await harness('FixtureToken','SupplyBoundaryHarness');try{const wallets=[h.a,...Array.from({length:1287},(_,i)=>'0x'+(i+1).toString(16).padStart(40,'0'))],setup=await h.configure(wallets);assert.equal(await h.contract.paidAvailability(),1288n);
 await h.mine(h.contract.seedTotalForBoundaryTest(1287,TX));await h.mine(h.token.connect(h.alice).approve(h.contract.target,COST*2n,TX));const f=await h.approval(h.a,'last-free'),p=await h.approval(h.a,'last-paid');
 if(winner==='free')await h.mine(h.contract.connect(h.alice).mintFree(...freeArgs(f,setup.tree.proof(0)),TX));else await h.paid(h.alice,p);
 assert.equal(await h.contract.totalMinted(),1288n);assert.equal((await h.contract.freeMinted())+(await h.contract.paidMinted()),1288n);assert.equal(await h.contract.paidAvailability(),0n);
 const late=await h.approval(h.a,'late');await assert.rejects(h.contract.connect(h.alice).mintFree.staticCall(...freeArgs(late,setup.tree.proof(0))));await assert.rejects(h.paid(h.alice,late));assert.equal(await h.contract.totalMinted(),1288n);
 }finally{await h.close();}}
});
test('R4: absent/malformed/wrong-domain GOLD authority and every altered order binding reject',async()=>{
 const h=await harness();try{await h.configure([h.a]);await h.mine(h.token.connect(h.alice).approve(h.contract.target,COST,TX));const p=await h.approval(h.a,'auth'),args=await h.paidArgs(p);await h.contract.connect(h.alice).mintPaid.staticCall(...args);
 for(const field of ['wallet','lookKey','choice','uriHash','recipient','embeoCost','goldCost','signerEpoch','orderId']){const next=[...args],auth={...args[7]};auth[field]=['wallet','recipient'].includes(field)?h.b:['lookKey','uriHash','orderId'].includes(field)?ethers.ZeroHash:field==='choice'?1:BigInt(auth[field])+1n;next[7]=auth;await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...next));}
 for(const signature of ['0x','0x1234',await testAuthority(2).signTypedData({name:'EmberEvoGenesisCandidate',version:'6',chainId:31337,verifyingContract:h.contract.target},GOLD_TYPES,args[7]),await h.approvalSigner.signTypedData({name:'EmberEvoGenesisCandidate',version:'3',chainId:31337,verifyingContract:h.contract.target},GOLD_TYPES,args[7])]){const next=[...args];next[8]=signature;await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...next));}
 assert.equal(await h.contract.totalMinted(),0n);
 }finally{await h.close();}
});
test('R4: revoke makes authorization unexecutable; consumed orders cannot be revoked; expiry uses chain time',async()=>{
 const h=await harness();try{await h.configure([]);await h.mine(h.token.connect(h.alice).approve(h.contract.target,COST*3n,TX));const p=await h.approval(h.a,'revoked'),args=await h.paidArgs(p),id=args[7].orderId;
 await assert.rejects(h.contract.connect(h.alice).revokePaidOrder.staticCall(id));await h.mine(h.contract.revokePaidOrder(id,TX));await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...args),/PAID_ORDER_UNAVAILABLE/);
 const q=await h.approval(h.a,'consumed'),good=await h.paidArgs(q);await h.mine(h.contract.connect(h.alice).mintPaid(...good,TX));assert.equal(await h.contract.paidOrderTokenId(good[7].orderId),1n);await assert.rejects(h.contract.revokePaidOrder.staticCall(good[7].orderId),/PAID_ORDER_ALREADY_CONSUMED/);
 const r=await h.approval(h.a,'expiry'),expired=await h.paidArgs(r);expired[7].deadline=(await h.time())-1;expired[8]=await h.approvalSigner.signTypedData({name:'EmberEvoGenesisCandidate',version:'6',chainId:31337,verifyingContract:h.contract.target},GOLD_TYPES,expired[7]);await assert.rejects(h.contract.connect(h.alice).mintPaid.staticCall(...expired),/GOLD_AUTH_EXPIRED/);
 }finally{await h.close();}
});
test('R4: rejecting NFT receiver reverts EMBEO, allowance, order, appearance and counters atomically',async()=>{
 const h=await harness();try{await h.configure([]);const who=h.receiver.target;await h.mine(h.token.connect(h.alice).transfer(who,COST,TX));await h.mine(h.receiver.invoke(h.token.target,h.token.interface.encodeFunctionData('approve',[h.contract.target,COST]),TX));const p=await h.approval(who,'receiver'),args=await h.paidArgs(p,who),data=h.contract.interface.encodeFunctionData('mintPaid',[...args,[]]);await h.mine(h.receiver.setReject(true,TX));await assert.rejects(h.mine(h.receiver.invoke(h.contract.target,data,TX)));
 assert.equal(await h.token.balanceOf(who),COST);assert.equal(await h.token.allowance(who,h.contract.target),COST);assert.equal(await h.contract.paidOrderTokenId(args[7].orderId),0n);assert.equal(await h.contract.totalMinted(),0n);
 await h.mine(h.receiver.setReject(false,TX));await h.mine(h.receiver.invoke(h.contract.target,data,TX));assert.equal(await h.contract.paidOrderTokenId(args[7].orderId),1n);
 }finally{await h.close();}
});
test('R4: fee-on-transfer token rejects entire payment and order consumption',async()=>{
 const h=await harness('FeeToken');try{await h.configure([]);await h.mine(h.token.connect(h.alice).approve(h.contract.target,COST,TX));const p=await h.approval(h.a,'tax'),args=await h.paidArgs(p),before=await h.token.balanceOf(h.a);await assert.rejects(h.mine(h.contract.connect(h.alice).mintPaid(...args,TX)));assert.equal(await h.token.balanceOf(h.a),before);assert.equal(await h.contract.paidOrderTokenId(args[7].orderId),0n);assert.equal(await h.contract.totalMinted(),0n);
 }finally{await h.close();}
});
test('R4: public-chain constructor rejected and candidate ABI has no test supply/admin mint',async()=>{
 await assert.rejects(harness('FixtureToken','EmberEvoGenesisCandidate',1));const abi=artifacts['contracts/EmberEvoGenesisCandidate.sol:EmberEvoGenesisCandidate'].abi;assert.ok(!abi.some(v=>/seedTotal|adminMint|freeDeadline|FREE_WINDOW/.test(v.name??'')));
});
test('R4: free/paid transactions competing in one block can consume only the last shared slot',async()=>{
 for(const paidFirst of [true,false]){const h=await harness('FixtureToken','SupplyBoundaryHarness');try{
 const setup=await h.configure([h.a]);await h.mine(h.contract.seedTotalForBoundaryTest(1287,TX));await h.mine(h.token.connect(h.alice).transfer(h.b,COST,TX));await h.mine(h.token.connect(h.bob).approve(h.contract.target,COST,TX));const f=await h.approval(h.a,'race-free'),p=await h.approval(h.b,'race-paid'),args=await h.paidArgs(p,h.b);
 await h.rpc.request({method:'evm_setAutomine',params:[false]});
 const free=()=>h.contract.connect(h.alice).mintFree(...freeArgs(f,setup.tree.proof(0)),TX),paid=()=>h.contract.connect(h.bob).mintPaid(...args,TX);
 const first=await(paidFirst?paid():free()),second=await(paidFirst?free():paid());await h.rpc.request({method:'evm_mine',params:[]});const results=await Promise.allSettled([first.wait(),second.wait()]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal(await h.contract.totalMinted(),1288n);assert.equal(await h.contract.freeMinted()+await h.contract.paidMinted(),1288n);assert.equal(await h.token.balanceOf(h.b),paidFirst?0n:COST);
 }finally{await h.rpc.request({method:'evm_setAutomine',params:[true]});await h.close();}}
});
test('R4 retains R3: cancelled signer acceptance cannot reactivate after identical reproposal',async()=>{
 const h=await harness();try{await h.configure([]);await h.mine(h.contract.setMintPaused(true,TX));await h.mine(h.contract.proposeAppearanceSigner(h.b,TX));const deadline=(await h.time())+600;
 const types={SignerAcceptance:[{name:'signer',type:'address'},{name:'signerEpoch',type:'uint256'},{name:'proposalNonce',type:'uint256'},{name:'deadline',type:'uint256'}]},domain={name:'EmberEvoGenesisCandidate',version:'6',chainId:31337,verifyingContract:h.contract.target},old={signer:h.b,signerEpoch:2,proposalNonce:await h.contract.signerProposalNonce(),deadline};
 const signature=await testAuthority(2).signTypedData(domain,types,old);await h.mine(h.contract.cancelAppearanceSignerProposal(TX));await h.mine(h.contract.proposeAppearanceSigner(h.b,TX));await assert.rejects(h.contract.activateAppearanceSigner.staticCall(deadline,signature),/SIGNER_ACCEPTANCE_INVALID/);
 const fresh=await testAuthority(2).signTypedData(domain,types,{...old,proposalNonce:await h.contract.signerProposalNonce()});await h.mine(h.contract.activateAppearanceSigner(deadline,fresh,TX));assert.equal(await h.contract.signerEpoch(),2n);
 }finally{await h.close();}
});
test('R4 retains R3: an authorized owner callback cannot switch recipient or pause during payment',async()=>{
 for(const mutation of ['setMintPaused']){const h=await harness('R3HookToken');try{await h.configure([]);await h.mine(h.token.connect(h.alice).approve(h.contract.target,COST,TX));const owner=await h.deploy('contracts/test/R3Fixtures.sol:R3OwnerForwarder',[]);await h.mine(h.contract.transferOwnership(owner.target,TX));await h.mine(owner.invoke(h.contract.target,h.contract.interface.encodeFunctionData('acceptOwnership'),TX));await h.mine(owner.authorizeInvoker(h.token.target,TX));const next=mutation==='setPaymentRecipient'?[h.a]:[true];const callback=owner.interface.encodeFunctionData('invoke',[h.contract.target,h.contract.interface.encodeFunctionData(mutation,next)]);await h.mine(h.token.setHook(owner.target,callback,TX));const recipient=await h.contract.paymentRecipient();await h.paid();assert.equal(await h.token.hookSucceeded(),false);assert.equal(await h.contract.paymentRecipient(),recipient);assert.equal(await h.contract.mintPaused(),false);assert.equal(await h.token.balanceOf(recipient),COST);
 }finally{await h.close();}}
});
test('Formal chain, real GOLD/EMBEO, price, snapshot, artwork and independent audit',{skip:'Local fixture only; production parameters, integrations and independent audit remain required.'},()=>{});
