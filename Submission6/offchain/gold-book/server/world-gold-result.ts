import {FORTUNE_PRODUCTS,fortuneProduct} from '../src/shared/fortunePricing.ts';
/** Review fixture contracts for research/fortune results, not proof that a real
 * upstream report exists. Real provider adapters must additionally validate
 * their service-specific signed/authenticated response before this boundary. */
const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0;
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export const GOLD_RESULT_PRODUCTS:readonly string[]=['research','research-pass','fortune',...FORTUNE_PRODUCTS.map(p=>p.product)];
export const hasGoldResultContract=(product:string)=>GOLD_RESULT_PRODUCTS.some(p=>p===product);
function usableDocument(product:string,v:unknown){
 if(!hasGoldResultContract(product))return false;
 // A bare non-JSON upstream error is not a report. Historical rows remain
 // stored and are flagged by inspection, rather than silently accepted here.
 if(!record(v))return false;
 if(fortuneProduct(product))return Object.keys(v).length===6&&v.schema==='celestao-receipt/v1'&&v.provider==='celestao-v1'&&v.system===fortuneProduct(product)!.system&&
  typeof v.recordId==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v.recordId)&&typeof v.documentHash==='string'&&/^[0-9a-f]{64}$/.test(v.documentHash)&&
  Number.isSafeInteger(v.createdMs)&&Number(v.createdMs)>0;
 if(text(v.report)||text(v.content))return true;
 // Zero signals, a numeric zero or false can be a meaningful documented result.
 if(v.status==='no-signal')return text(v.explanation)&&Array.isArray(v.signals)&&v.signals.length===0;
 return v.status==='ok'&&text(v.explanation)&&Object.hasOwn(v,'value')&&
  (typeof v.value==='boolean'||typeof v.value==='number'&&Number.isFinite(v.value));
}
export function encodeGoldResult(product:string,result:unknown):{json:string|null;failure:string|null}{
 let json:string|undefined;
 try{json=JSON.stringify(result);}catch{return {json:null,failure:'RESULT_NOT_SERIALIZABLE'};}
 if(typeof json!=='string')return {json:null,failure:'RESULT_NOT_SERIALIZABLE'};
 if(new TextEncoder().encode(json).length>16000)return {json:null,failure:'RESULT_TOO_LARGE'};
 // Validate the value actually persisted, including objects with toJSON hooks.
 const stored:unknown=JSON.parse(json);
 if(!usableDocument(product,stored))return {json:null,failure:'RESULT_UNUSABLE'};
 // TextEncoder silently replaces lone surrogates. Reject rather than changing
 // report contents while classifying a delivery as successful.
 const stack:unknown[]=[stored];
 while(stack.length){const v=stack.pop();
  if(typeof v==='string'&&/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v))return {json:null,failure:'RESULT_INVALID_UNICODE'};
  if(Array.isArray(v))stack.push(...v);else if(record(v))for(const [k,x] of Object.entries(v))stack.push(k,x);
 }
 return {json,failure:null};
}

/** Opaque INTERNAL auth document plus the separately typed complete MintBinding.
 * Only lossless plain JSON objects are allowed. No coercion or silent removal
 * of undefined/functions/symbols, custom serializers, cycles or nonfinite data.
 * Existing JSON bytes/key order and full retry equality are preserved. */
export function encodeMintAuth(auth:unknown,binding:{id:string;wallet:string;gold:string;deadline:number;chainId:number;contract:string;chainInstance:string;domainVersion?:string;recipient?:string}):string{
 const seen=new Set<object>();
 const visit=(v:unknown,depth:number):boolean=>{
  if(depth>32)return false;
  if(v===null||typeof v==='boolean'||typeof v==='string')return true;
  if(typeof v==='number')return Number.isFinite(v);
  if(typeof v!=='object')return false;
  if(seen.has(v))return false;
  if(!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)return false;
  if(Array.isArray(v)&&Object.keys(v).length!==v.length)return false;
  seen.add(v);
  const descriptors=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(v);
  const ok=keys.every(k=>typeof k==='string'&&(Array.isArray(v)&&k==='length'||
   descriptors[k].enumerable&&Object.hasOwn(descriptors[k],'value')&&visit(descriptors[k].value,depth+1)));
  seen.delete(v);return ok;
 };
 try{
  if(!record(auth)||!Object.keys(auth).length||!visit(auth,0))throw Error();
  const encoded=JSON.stringify(auth);
  if(typeof encoded!=='string'||new TextEncoder().encode(encoded).length>16000)throw Error();
  const doc=JSON.parse(encoded) as Record<string,unknown>;
  const sameAddress=(v:unknown,w:string)=>typeof v==='string'&&/^0x[0-9a-fA-F]{40}$/.test(v)&&v.toLowerCase()===w;
  const uint=(v:unknown)=>typeof v==='string'&&/^(0|[1-9][0-9]{0,77})$/.test(v);
  const hash=(v:unknown)=>typeof v==='string'&&/^0x[0-9a-fA-F]{64}$/.test(v);
  if(doc.schema==='genesis-r5-paid-v1'){
   // Genesis paid order (server/genesis-gold.ts builds it): lookKey + choice replace R4's key. Domain version and
   // recipient must be the deployment's own, which the binding carries from the registry: Genesis audit b0b1d96a,
   // finding 3 (a binding without them is refused).
   const o=doc.order,d=doc.domain,c=doc.consent,low=(v:unknown)=>typeof v==='string'&&/^0x[0-9a-f]{64}$/.test(v)&&!/^0x0{64}$/.test(v);
   if(!record(o)||!record(d)||!record(c)||d.name!=='EmberEvoGenesisCandidate'||typeof binding.domainVersion!=='string'||d.version!==binding.domainVersion||d.chainId!==binding.chainId||!sameAddress(d.verifyingContract,binding.contract)
    ||doc.deploymentId!==binding.chainInstance||!hash(doc.codeHash)||o.orderId!==binding.id||!low(o.orderId)||!sameAddress(o.wallet,binding.wallet)
    ||o.goldCost!==binding.gold||!uint(o.deadline)||Number(o.deadline)*1000!==binding.deadline||!low(o.lookKey)||!hash(o.uriHash)
    ||!Number.isInteger(o.choice)||(o.choice as number)<0||(o.choice as number)>3||typeof o.recipient!=='string'||!/^0x[0-9a-f]{40}$/.test(o.recipient)
    ||typeof binding.recipient!=='string'||o.recipient!==binding.recipient
    ||!uint(o.embeoCost)||!uint(o.signerEpoch)||o.signerEpoch==='0'||typeof c.signature!=='string'||!/^0x[0-9a-fA-F]{130}$/.test(c.signature))throw Error();
  }else if(Object.hasOwn(doc,'auth')){
   const a=doc.auth,p=doc.packet,anchor=doc.chainAnchor;
   if(!record(a)||!record(p)||!record(p.domain)||!record(anchor)||!hash(anchor.genesisHash)||!hash(anchor.codeHash)
    ||a.orderId!==binding.id||!sameAddress(a.wallet,binding.wallet)||a.goldCost!==binding.gold||!Number.isSafeInteger(a.deadline)||Number(a.deadline)*1000!==binding.deadline
    ||!hash(a.key)||!hash(a.uriHash)||!uint(a.embeoCost)||!uint(a.signerEpoch)||typeof a.recipient!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(a.recipient)
    ||p.route!=='paid'||p.runId!==binding.chainInstance||p.domain.chainId!==binding.chainId||!sameAddress(p.domain.verifyingContract,binding.contract)
    ||!sameAddress(p.walletAddress,binding.wallet)||p.key!==a.key||p.deadline!==a.deadline||p.signerEpoch!==a.signerEpoch||p.expectedRecipient!==a.recipient||p.expectedCost!==a.embeoCost)throw Error();
  }else{
   // Existing recorded fixture auth is wallet/order-bound. Neither form is a
   // browser authorization or proof that the production signer is installed.
   if(doc.id!==binding.id||!sameAddress(doc.wallet,binding.wallet)||(Object.hasOwn(doc,'cost')&&doc.cost!==binding.gold))throw Error();
  }
  return encoded;
 }catch{throw Error('INVALID_MINT_AUTH');}
}
