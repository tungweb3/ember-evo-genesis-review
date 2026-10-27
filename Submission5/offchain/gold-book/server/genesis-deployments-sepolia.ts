import type {GenesisDeployment} from './genesis-gold.ts';
// Genesis deployments of the Sepolia rehearsal book only (worker/gold-sepolia.ts), copied from the Genesis deploy
// records in contract/deployments/ (contract, deploy block, runtime code hash and the two immutable costs read back from
// the chain). Test prices for the rehearsal, not the production price.
// 2026-10-27: rebuilt from the 10-25 backup after the C: drive failure; the 10-26 entry (sepolia-r6-rehearsal-2) is
// re-added from its deploy record 11155111-1792981877328.json (code hash checked against the chain), and the friends'
// test deployment follows it.
export const SEPOLIA_GENESIS_DEPLOYMENTS:readonly GenesisDeployment[]=Object.freeze([Object.freeze({
 id:'sepolia-r5-rehearsal-1',environment:'sepolia',chainId:11155111,
 contract:'0xa45bfda6aa98e5841651983e038f5ac30dd881a3',
 codeHash:'0xa89682feb8bc3162dcba998588b1a9a9e74972973d24b6c5f0c0a6cb9d41b52a',
 deployBlock:'11963377',embeoCost:'300000000000000000000000',goldCost:'1',
 signer:'0x4499624CBF0D1B32CC84DAc877E9cF76D25cd4eB'}),Object.freeze({
 id:'sepolia-r6-rehearsal-2',environment:'sepolia',chainId:11155111,
 contract:'0xdd4ae794483b81e21e02a6561e7c0a64b1c92026',
 codeHash:'0x803ab22b92fb5492664c4c77966ebfa44243eda5c6806a58c8001f5f51f1226b',
 deployBlock:'11995013',embeoCost:'400000000000000000000000',goldCost:'1200',
 signer:'0x53db73f70385AeB3BcbD3173e2f6f94E45105C6d'}),Object.freeze({
 // friends' test deployment (owner 2026-10-27): chosen-skin URIs derived, not stored; record 11155111-1793035133359.json,
 // code hash checked against the chain
 id:'sepolia-r6-rehearsal-3',environment:'sepolia',chainId:11155111,
 contract:'0x23b181ad43caec4541cde2d04c41e997de335372',
 codeHash:'0x1ebf4ebaa22417b9a98e0466ec2d379b21327b3a3e70eef6918f1fd034390f0b',
 deployBlock:'11999432',embeoCost:'400000000000000000000000',goldCost:'1200',
 signer:'0x53db73f70385AeB3BcbD3173e2f6f94E45105C6d'}),Object.freeze({
 // pre-audit build (owner 2026-10-27): random seeds from the signer's committed secrets + block hash; record
 // 11155111-1793045717595.json, code hash checked against the chain
 id:'sepolia-r6-rehearsal-4',environment:'sepolia',chainId:11155111,
 contract:'0x7028e57466c36a7c8135980ca3fbf77d277e9a93',
 codeHash:'0xbfc7bb4f5e9b6cfec1c953a7c2502b52574b1c62fe6e660d5d867438c7536a19',
 deployBlock:'12000312',embeoCost:'400000000000000000000000',goldCost:'1200',
 signer:'0x53db73f70385AeB3BcbD3173e2f6f94E45105C6d'}),Object.freeze({
 // same contract rebuilt with solc 0.8.38 (SOL-2026-7 fix) and a fresh reveal seed (owner 2026-10-27); record
 // 11155111-1793063966361.json, code hash checked against the chain
 id:'sepolia-r6-rehearsal-5',environment:'sepolia',chainId:11155111,
 contract:'0x8ce67008570ed41f64e4be149ecaa66d1abe2efa',
 codeHash:'0x596274cfa725311d28083323cb6aa69057553f81fc67281fa6c35952c4e76ad4',
 deployBlock:'12001804',embeoCost:'400000000000000000000000',goldCost:'1200',
 signer:'0x53db73f70385AeB3BcbD3173e2f6f94E45105C6d'}),Object.freeze({
 // Swarm audit fixes + packed storage (owner 2026-10-27; EIP-712 domain version 7); record 11155111-1793072261196.json,
 // code hash checked against the chain
 id:'sepolia-r6-rehearsal-6',environment:'sepolia',chainId:11155111,
 contract:'0xb972164188e5164402edbacba3f6f95decfba836',
 codeHash:'0x065d775440ee4fbd149f1c112c3ad9f3d871b75eec5ebd19d7e9806f13c14a7e',
 deployBlock:'12002478',embeoCost:'400000000000000000000000',goldCost:'1200',
 signer:'0x53db73f70385AeB3BcbD3173e2f6f94E45105C6d',domainVersion:'7'}),Object.freeze({
 // gas repack + pre-deployment review L-1/L-2 (owner 2026-10-27; EIP-712 domain version 7); record
 // 11155111-1793114237482.json, code hash checked against the chain
 id:'sepolia-r6-rehearsal-7',environment:'sepolia',chainId:11155111,
 contract:'0x0fb5b6e5c1b026c611900a864755fac86dad4085',
 codeHash:'0xa54bede76104157ccc57079167105d2312ddd7de7267a32f8e9ebd82db4932db',
 deployBlock:'12005964',embeoCost:'400000000000000000000000',goldCost:'1200',
 signer:'0x53db73f70385AeB3BcbD3173e2f6f94E45105C6d',domainVersion:'7'}),Object.freeze({
 // Submission 4 (owner 2026-10-28): audit d726b1cd fixes, 1,688 supply, 20 tUSD + 1,200 GOLD paid to the treasury Safe
 // address, gas review; record 11155111-1793130400217.json, code hash checked against the chain. embeoCost = the
 // payment-token amount (TestUSD here, imdUSD on mainnet).
 id:'sepolia-r6-rehearsal-8',environment:'sepolia',chainId:11155111,
 contract:'0xd5f3a0cdc26c3d19b7e657586f2ea2483a7bf8af',
 codeHash:'0x32654b22ba8c6280005b7116f93900239d26d6cb4f515b830d9fd577dceebdb1',
 deployBlock:'12007308',embeoCost:'20000000000000000000',goldCost:'1200',
 signer:'0x53db73f70385AeB3BcbD3173e2f6f94E45105C6d',domainVersion:'7',
 recipient:'0x29e7c208481f648795f677b55f6ecb2badc2f01e'}),Object.freeze({
 // Submission 5 (2026-10-28): audit b0b1d96a fixes (reveal-commitment acceptance bound to a recent block hash); same
 // price, supply, recipient and domain as Submission 4; record 11155111-1793141907357.json, code hash checked against the chain.
 id:'sepolia-r6-rehearsal-9',environment:'sepolia',chainId:11155111,
 contract:'0x6a7626c15c4746da348e4d11f6f38228c743d25d',
 codeHash:'0xfde48e7a4c1a459568f5111e102aaac5fef802396eabc9ba066b699f09cf1278',
 deployBlock:'12008266',embeoCost:'20000000000000000000',goldCost:'1200',
 signer:'0x53db73f70385AeB3BcbD3173e2f6f94E45105C6d',domainVersion:'7',
 recipient:'0x29e7c208481f648795f677b55f6ecb2badc2f01e'})]);
