import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {harness,COST,TX} from './hardening-harness.mjs';
import {ethers,testAuthority} from '../tools/runtime.mjs';
import config from '../config/genesis.json' with {type:'json'};
const measured={};
const appearanceTypes={Appearance:[{name:'wallet',type:'address'},{name:'lookKey',type:'bytes32'},{name:'choice',type:'uint8'},{name:'uriHash',type:'bytes32'},{name:'deadline',type:'uint256'},{name:'signerEpoch',type:'uint256'},{name:'paid',type:'bool'}]};
const acceptanceTypes={SignerAcceptance:[{name:'signer',type:'address'},{name:'signerEpoch',type:'uint256'},{name:'proposalNonce',type:'uint256'},{name:'deadline',type:'uint256'}]};
const domain=async(h,extra={})=>({name:'EmberEvoGenesisCandidate',version:'7',chainId:31337,verifyingContract:await h.contract.getAddress(),...extra});
async function approval(h,who,tag,signer=h.approvalSigner,epoch=undefined){
 const key=ethers.keccak256(ethers.toUtf8Bytes('LOCAL_REVIEW_LOOK/'+tag)),uri='ipfs://LOCAL_ONLY/'+tag,deadline=(await h.time())+300000;
 const value={wallet:who,lookKey:key,choice:0,uriHash:ethers.keccak256(ethers.toUtf8Bytes(uri)),deadline,signerEpoch:epoch??await h.contract.signerEpoch()};
 const signature=await signer.signTypedData(await domain(h),appearanceTypes,{...value,paid:false}),paidSignature=await signer.signTypedData(await domain(h),appearanceTypes,{...value,paid:true});
 return {key,choice:0,uri,deadline,signature,paidSignature,wallet:who,authority:signer};
}
async function acceptance(h,next,signer,opts={}){
 const deadline=opts.deadline??(await h.time())+3600,epoch=opts.epoch??(await h.contract.signerEpoch())+1n;
 return {deadline,signature:await signer.signTypedData(await domain(h,opts.domain??{}),acceptanceTypes,{signer:next,signerEpoch:epoch,proposalNonce:opts.proposalNonce??await h.contract.signerProposalNonce(),deadline})};
}
async function rotate(h,next,signer){
 await h.mine(h.contract.setMintPaused(true,TX));await h.mine(h.contract.proposeAppearanceSigner(next,TX));
 const p=await acceptance(h,next,signer);await h.mine(h.contract.activateAppearanceSigner(p.deadline,p.signature,TX));await h.mine(h.contract.setMintPaused(false,TX));
}
const paidData=async(h,p)=>h.contract.interface.encodeFunctionData('mintPaid',[...await h.paidArgs(p),await h.reveals()]);
async function wallet(h,withApproval=true){
 const w=await h.deploy('contracts/test/HardeningFixtures.sol:HardeningWallet',[]),who=await w.getAddress();
 await h.mine(h.token.connect(h.alice).transfer(who,COST*4n,TX));
 if(withApproval)await h.mine(w.invoke(await h.token.getAddress(),h.token.interface.encodeFunctionData('approve',[await h.contract.getAddress(),COST*4n]),TX));
 return {w,who};
}
test('H1: EOA and live ERC1271 authority both mint; malformed and revoked contract signatures reject without state',async()=>{
 for(const mode of ['eoa','erc1271']){const h=await harness('FixtureToken','EmberEvoGenesisCandidate',31337,mode);try{
  const setup=await h.configure([h.a]),p=await h.approval(h.a,'authority-'+mode);
  await assert.rejects(h.contract.connect(h.alice).mintFree.staticCall(p.key,p.choice,p.uri,p.deadline,'0x1234',setup.tree.proof(0)),/APPEARANCE_AUTHORITY/);
  const legacyTypes={Appearance:appearanceTypes.Appearance.filter(f=>f.name!=='signerEpoch')};
  const legacy=await h.approvalSigner.signTypedData(await domain(h,{version:'1'}),legacyTypes,{wallet:h.a,lookKey:p.key,choice:0,uriHash:ethers.keccak256(ethers.toUtf8Bytes(p.uri)),deadline:p.deadline});
  await assert.rejects(h.contract.connect(h.alice).mintFree.staticCall(p.key,p.choice,p.uri,p.deadline,legacy,setup.tree.proof(0)),/APPEARANCE_AUTHORITY/);
  if(h.contractSigner){await h.mine(h.contractSigner.setEnabled(false,TX));await assert.rejects(h.contract.connect(h.alice).mintFree.staticCall(p.key,p.choice,p.uri,p.deadline,p.signature,setup.tree.proof(0)),/APPEARANCE_AUTHORITY/);await h.mine(h.contractSigner.setEnabled(true,TX));}
  assert.equal(await h.contract.totalMinted(),0n);await h.mine(h.contract.connect(h.alice).mintFree(p.key,p.choice,p.uri,p.deadline,p.signature,setup.tree.proof(0),TX));assert.equal(await h.contract.totalMinted(),1n);
 }finally{await h.close();}}
 measured.H1={validEOA:true,validERC1271:true,malformedRejected:true,legacyDomainRejected:true,revoked1271Rejected:true};
});
test('H2: staged EOA rotation requires pause/admin/proven acceptance; signed epoch rejects old approvals even after A-B-A',async()=>{
 const h=await harness();try{
  await h.configure([]);await h.mine(h.token.connect(h.alice).approve(await h.contract.getAddress(),COST*4n,TX));
  const first=await approval(h,h.a,'before-rotation'),unused=await approval(h,h.a,'unused-old');await h.paid(h.alice,first);
  const bobAuthority=testAuthority(2);assert.equal(bobAuthority.address,h.b);
  await assert.rejects(h.contract.proposeAppearanceSigner.staticCall(h.b),/PAUSE_REQUIRED/);
  await h.mine(h.contract.setMintPaused(true,TX));await assert.rejects(h.contract.connect(h.alice).proposeAppearanceSigner.staticCall(h.b));
  await h.mine(h.contract.proposeAppearanceSigner(h.b,TX));await assert.rejects(h.contract.setMintPaused.staticCall(false),/SIGNER_PROPOSAL_PENDING/);
  const wrong=await acceptance(h,h.b,h.approvalSigner);await assert.rejects(h.contract.activateAppearanceSigner.staticCall(wrong.deadline,wrong.signature),/SIGNER_ACCEPTANCE_INVALID/);
  const accepted=await acceptance(h,h.b,bobAuthority);await h.mine(h.contract.activateAppearanceSigner(accepted.deadline,accepted.signature,TX));assert.equal(await h.contract.signerEpoch(),2n);await h.mine(h.contract.setMintPaused(false,TX));
  await assert.rejects(h.paid(h.alice,unused));await h.paid(h.alice,await approval(h,h.a,'new-epoch',bobAuthority));
  await rotate(h,await h.admin.getAddress(),h.approvalSigner);assert.equal(await h.contract.signerEpoch(),3n);await assert.rejects(h.paid(h.alice,unused));
  const duplicate=await approval(h,h.a,'before-rotation');await h.paid(h.alice,duplicate); // R6: a fresh approval of a look already minted is fine (looks may repeat)
  await h.paid(h.alice,await approval(h,h.a,'unused-old'));
  // 2026-10-27: a chosen token's URI is derived from the reveal base (locked by h.configure), not the URI sent at mint
  assert.equal((await h.contract.tokenLook(1)).lookKey,first.key);assert.equal(await h.contract.tokenURI(1),'ipfs://LOCAL_ONLY/revealed/'+first.key+'/0');assert.equal(await h.contract.totalMinted(),4n);   // R6: the repeated look is token 3
  measured.H2={epoch:'3',oldUnusedRejectedAfterABA:true,freshApprovalForUnusedLookWorks:true,oldNFTPreserved:true,repeatedLookAllowedAfterRotation:true};
 }finally{await h.close();}
});
test('H2: cancellation preserves current approvals; ERC1271 activation validates deadline, epoch, chain and contract',async()=>{
 const h=await harness();try{
  const setup=await h.configure([h.a]);const old=await approval(h,h.a,'cancel-proposal');
  const next=await h.deploy('contracts/test/HardeningFixtures.sol:ContractAuthority',[await h.admin.getAddress()]),who=await next.getAddress();
  await h.mine(h.contract.setMintPaused(true,TX));await h.mine(h.contract.proposeAppearanceSigner(who,TX));
  for(const opts of [{domain:{chainId:1}},{domain:{verifyingContract:h.b}},{epoch:9n}]){const p=await acceptance(h,who,h.approvalSigner,opts);await assert.rejects(h.contract.activateAppearanceSigner.staticCall(p.deadline,p.signature),/SIGNER_ACCEPTANCE_INVALID/);}
  const expired=await acceptance(h,who,h.approvalSigner,{deadline:(await h.time())-1});await assert.rejects(h.contract.activateAppearanceSigner.staticCall(expired.deadline,expired.signature),/SIGNER_ACCEPTANCE_EXPIRED/);
  const accepted=await acceptance(h,who,h.approvalSigner);await assert.rejects(h.contract.connect(h.alice).activateAppearanceSigner.staticCall(accepted.deadline,accepted.signature));
  await h.mine(h.contract.cancelAppearanceSignerProposal(TX));assert.equal(await h.contract.signerEpoch(),1n);await h.mine(h.contract.setMintPaused(false,TX));
  await h.mine(h.contract.connect(h.alice).mintFree(old.key,old.choice,old.uri,old.deadline,old.signature,setup.tree.proof(0),TX));
  await rotate(h,who,h.approvalSigner);assert.equal(await h.contract.appearanceSigner(),who);await h.mine(h.token.connect(h.alice).approve(await h.contract.getAddress(),COST,TX));await h.openPaid();await h.paid(h.alice,await approval(h,h.a,'activated-contract'));
  measured.signerAcceptance={cancelPreservesCurrentApproval:true,valid1271Activation:true,wrongEpochChainContractAndExpiredRejected:true,nonOwnerRejected:true};
 }finally{await h.close();}
});
test('H2: admin can recover from a revoked/unusable authority without its consent; invalid role proposals reject',async()=>{
 const h=await harness('FixtureToken','EmberEvoGenesisCandidate',31337,'erc1271');try{
  await h.configure([]);await h.mine(h.contractSigner.setEnabled(false,TX));await h.mine(h.token.connect(h.alice).approve(await h.contract.getAddress(),COST,TX));
  await assert.rejects(h.paid(h.alice,await approval(h,h.a,'revoked-old')));await h.mine(h.contract.setMintPaused(true,TX));
  for(const next of [ethers.ZeroAddress,await h.contract.getAddress(),await h.contract.appearanceSigner()])await assert.rejects(h.contract.proposeAppearanceSigner.staticCall(next),/INVALID_SIGNER/);
  await rotate(h,h.b,testAuthority(2));await h.paid(h.alice,await approval(h,h.a,'recovered',testAuthority(2)));assert.equal(await h.contract.totalMinted(),1n);
  measured.signerRecovery={revokedAuthorityRecovered:true,zeroSelfSameRoleRejected:true};
 }finally{await h.close();}
});
test('H3: renunciation always rejects while two-step ownership transfer and new-owner controls continue working',async()=>{
 const h=await harness();try{
  await h.configure([]);const owner=await h.admin.getAddress();
  for(const paused of [true,false]){await h.mine(h.contract.setMintPaused(paused,TX));await assert.rejects(h.contract.renounceOwnership.staticCall(),/OWNERSHIP_RENOUNCE_DISABLED/);await assert.rejects(h.mine(h.admin.sendTransaction({to:await h.contract.getAddress(),data:h.contract.interface.encodeFunctionData('renounceOwnership'),...TX})));assert.equal(await h.contract.owner(),owner);}
  await h.mine(h.contract.transferOwnership(h.b,TX));assert.equal(await h.contract.owner(),owner);assert.equal(await h.contract.pendingOwner(),h.b);await assert.rejects(h.contract.connect(h.alice).acceptOwnership.staticCall());
  await h.mine(h.contract.connect(h.bob).acceptOwnership(TX));await assert.rejects(h.contract.setMintPaused.staticCall(true));await h.mine(h.contract.connect(h.bob).setMintPaused(true,TX));await assert.rejects(h.contract.connect(h.bob).renounceOwnership.staticCall(),/OWNERSHIP_RENOUNCE_DISABLED/);await h.mine(h.contract.connect(h.bob).setMintPaused(false,TX));
  measured.H3={renounceRejectedPausedAndUnpaused:true,twoStepTransferWorks:true,newOwnerCanResume:true};
 }finally{await h.close();}
});
test('H4: two paid calls in a batch revert atomically; caught second call rejects and a later transaction can mint',async()=>{
 const h=await harness();try{
  await h.configure([]);const {w,who}=await wallet(h),p=await approval(h,who,'batch-one'),q=await approval(h,who,'batch-two'),one=await paidData(h,p),two=await paidData(h,q);
  const before=await h.token.balanceOf(who);await assert.rejects(w.batch.staticCall(await h.contract.getAddress(),[one,two]),/ONE_PAID_MINT_PER_TRANSACTION/);await assert.rejects(h.mine(w.batch(await h.contract.getAddress(),[one,two],TX)));
  assert.equal(await h.contract.totalMinted(),0n);assert.equal(await h.token.balanceOf(who),before);
  const receipt=await h.mine(w.catchSecond(await h.contract.getAddress(),one,two,TX));assert.equal(await w.firstSucceeded(),true);assert.equal(await w.secondSucceeded(),false);
  const reason=ethers.AbiCoder.defaultAbiCoder().decode(['string'],ethers.dataSlice(await w.secondError(),4))[0];assert.equal(reason,'ONE_PAID_MINT_PER_TRANSACTION');
  assert.equal(await h.contract.totalMinted(),1n);assert.equal(await h.token.balanceOf(config.receivingAddress),COST);
  await h.mine(w.invoke(await h.contract.getAddress(),two,TX));assert.equal(await h.contract.totalMinted(),2n);assert.equal(await h.token.balanceOf(config.receivingAddress),COST*2n);
  measured.H4={caughtBatchTransaction:receipt.hash,secondRejected:true,atomicBatchRollback:true,nextTransactionSucceeds:true};
 }finally{await h.close();}
});
test('H4: two successful paid transactions from one wallet can be mined in the same block',async()=>{
 const h=await harness();try{
  await h.configure([]);const {w,who}=await wallet(h),p=await approval(h,who,'same-block-one'),q=await approval(h,who,'same-block-two');
  await h.rpc.request({method:'evm_setAutomine',params:[false]});
  const nonce=Number(BigInt(await h.rpc.request({method:'eth_getTransactionCount',params:[await h.admin.getAddress(),'pending']})));
  const a=await w.invoke(await h.contract.getAddress(),await paidData(h,p),{...TX,nonce}),b=await w.invoke(await h.contract.getAddress(),await paidData(h,q),{...TX,nonce:nonce+1});
  await h.rpc.request({method:'evm_mine',params:[]});const [ra,rb]=await Promise.all([a.wait(),b.wait()]);assert.equal(ra.blockNumber,rb.blockNumber);assert.equal(await h.contract.totalMinted(),2n);
  measured.sameBlock={block:ra.blockNumber,twoDistinctTransactionsSucceeded:true};
 }finally{await h.rpc.request({method:'evm_setAutomine',params:[true]});await h.close();}
});
test('H4: a failed paid attempt releases its transient marker so corrected payment can succeed within that transaction',async()=>{
 const h=await harness();try{
  await h.configure([]);const {w,who}=await wallet(h,false),p=await approval(h,who,'failed-then-retry'),data=await paidData(h,p);
  const approve=h.token.interface.encodeFunctionData('approve',[await h.contract.getAddress(),COST]);
  await h.mine(w.retryAfterApproval(await h.contract.getAddress(),data,await h.token.getAddress(),approve,data,TX));
  assert.equal(await w.firstSucceeded(),false);assert.equal(await w.secondSucceeded(),true);assert.equal(await h.contract.totalMinted(),1n);assert.equal((await h.contract.totalMinted()-await h.contract.freeMinted()),1n);assert.equal(await h.token.balanceOf(config.receivingAddress),COST);
  measured.failedRetry={failedCallMarkerRolledBack:true,correctedCallSucceeded:true};
 }finally{await h.close();}
});
test('H4: caller-specific paid marker permits separate wallets in one transaction',async()=>{
 const h=await harness();try{
  await h.configure([]);const a=await wallet(h),b=await wallet(h),p=await approval(h,a.who,'caller-one'),q=await approval(h,b.who,'caller-two');
  await h.mine(a.w.batchTargets([await h.contract.getAddress(),await b.w.getAddress()],[await paidData(h,p),b.w.interface.encodeFunctionData('invoke',[await h.contract.getAddress(),await paidData(h,q)])],TX));
  assert.equal(await h.contract.ownerOf(1),a.who);assert.equal(await h.contract.ownerOf(2),b.who);assert.equal(await h.token.balanceOf(config.receivingAddress),COST*2n);
  measured.callerScope={separateWalletsRemainIndependent:true};
 }finally{await h.close();}
});
test('H5: ERC4906 discovery and exact token update event work; unauthorized, empty and nonexistent metadata updates reject',async()=>{
 const h=await harness();try{
  await h.configure([]);await h.mine(h.token.connect(h.alice).approve(await h.contract.getAddress(),COST,TX));const p=await approval(h,h.a,'metadata');await h.paid(h.alice,p);
  for(const id of ['0x49064906','0x01ffc9a7','0x80ac58cd'])assert.equal(await h.contract.supportsInterface(id),true);assert.equal(await h.contract.supportsInterface('0xffffffff'),false);
  const receipt=await h.mine(h.contract.setTokenURI(1,'ipfs://LOCAL_ONLY/metadata-update',TX));
  const updated=receipt.logs.map(l=>{try{return h.contract.interface.parseLog(l);}catch{return null;}}).find(l=>l?.name==='MetadataUpdate');assert.ok(updated);assert.equal(updated.args[0],1n);
  await assert.rejects(h.contract.connect(h.alice).setTokenURI.staticCall(1,'ipfs://wrong'));await assert.rejects(h.contract.setTokenURI.staticCall(2222,'ipfs://nonexistent'));await assert.rejects(h.contract.setTokenURI.staticCall(1,''));
  assert.equal(await h.contract.tokenURI(1),'ipfs://LOCAL_ONLY/metadata-update');assert.equal((await h.contract.tokenLook(1)).lookKey,p.key);
  measured.H5={interface:true,standardEventTokenId:'1',metadataAuthorityProtected:true,keyAndNameUnchanged:true};
 }finally{await h.close();}
});
after(()=>{mkdirSync(new URL('../evidence/',import.meta.url),{recursive:true});writeFileSync(new URL('../evidence/hardening-observations.json',import.meta.url),JSON.stringify(measured,null,2));});
