// Shared look rules for Genesis R6: the mint page and the approval signer use the same code.
// A look is a body plus one part (or none) per slot. Skin is not part of the look; it is the mint `choice`.
// v2 (owner 2026-10-22): accessories are part of the mint look again, in four slots (eyewear, neck, belt, strap).
import {keccak256,toUtf8Bytes} from '../vendor/ethers.min.js';
import CATALOGUE from './catalogue-data.mjs';

export {CATALOGUE};
export const ACC_SLOTS=['eyewear','neck','belt','strap'];
export const SLOTS=['hat','top','vest','outer','bottom','shoes',...ACC_SLOTS];
export const LOOK_FIELDS=['body',...SLOTS];
/** choice values the contract accepts: 0 green, 1 ice blue, 2 purple (chosen), 3 random. Pink/orange/gold are random only. */
export const CHOICE_RANDOM=3;
export const CANONICAL_PREFIX='emberevo-genesis-look:v2';

export class LookError extends Error{constructor(code){super(code);this.code=code;}}
const fail=code=>{throw new LookError(code);};

/** Exact fields only; a slot is a catalogue id of that slot, or null / '' for none. Returns the normalized look. */
export function normalizeLook(look,cat=CATALOGUE){
 if(!look||typeof look!=='object'||Array.isArray(look))fail('LOOK_INVALID');
 const keys=Object.keys(look);
 if(keys.length!==LOOK_FIELDS.length||!LOOK_FIELDS.every(k=>Object.hasOwn(look,k)))fail('LOOK_FIELDS_INVALID');
 if(!cat.bodies.includes(look.body))fail('BODY_UNKNOWN');
 const out={body:look.body};
 for(const slot of SLOTS){
  const v=look[slot];
  if(v===null||v==='')out[slot]=null;
  else if(typeof v==='string'&&cat.slots[slot].includes(v))out[slot]=v;
  else fail('PART_UNKNOWN');
 }
 return out;
}

/** Pairing rules that block a mint (the same blocking rules the mint page shows as errors). Returns rule codes.
 *  Owner 2026-10-26: only what visibly breaks the NFT image blocks; the other rules are warnings (ruleWarnings). Checked
 *  by drawing every rule's combinations as the page and the NFT image draw them (each layer over the one below). */
export function ruleViolations(L,cat=CATALOGUE){
 const occ=id=>cat.occupies[id]||[],v=[];
 // trousers under a coverall or diving suit: wide legs poke out at the knees as lumps, narrow ones are hidden entirely
 if(L.outer&&occ(L.outer).includes('bottom')&&L.bottom)v.push('OUTER_COVERS_BOTTOM');
 // part pairs still refused by hand (none since 2026-10-26; a colourway counts as its part)
 const worn=SLOTS.map(sl=>L[sl]).filter(Boolean).map(id=>id.split('@')[0]);
 if((cat.incompatible||[]).some(([x,y])=>worn.includes(x)&&worn.includes(y)))v.push('PARTS_CLIP');
 return v;
}

/** Pairing rules that only warn (owner 2026-10-26: they were blocks; in the 2D image they read as a layered look, or one
 *  piece is simply covered). The mint page shows them; the signer does not check them. Returns rule codes. */
export function ruleWarnings(L,cat=CATALOGUE){
 const occ=id=>cat.occupies[id]||[],flg=id=>cat.flags[id]||[],v=[];
 if(L.outer){
  if(occ(L.outer).includes('top')&&L.top)v.push('OUTER_COVERS_TOP');
  if(flg(L.outer).includes('tail')&&!L.vest)v.push('TAILCOAT_NEEDS_VEST');
  if(L.vest&&flg(L.outer).includes('onepiece'))v.push('VEST_WITH_ONEPIECE');
 }
 if(L.vest&&L.bottom&&flg(L.bottom).includes('bib'))v.push('VEST_WITH_BIB');
 if(L.top&&flg(L.top).includes('collar')&&!L.outer)v.push('COLLAR_NEEDS_JACKET');
 if(L.top&&cat.noLayerOver.includes(L.top)&&(L.vest||L.outer))v.push('TOP_CANNOT_BE_LAYERED');
 // suspenders hang from trouser buttons: without trousers the clips hang free, and bib overalls have their own straps
 if(L.strap&&(!L.bottom||flg(L.bottom).includes('bib')))v.push('STRAP_NEEDS_TROUSERS');
 const worn=SLOTS.map(sl=>L[sl]).filter(Boolean).map(id=>id.split('@')[0]);
 // parts that leave the torso bare need a real top (a collar insert is only a neck patch) or a one-piece outer that covers it
 const collarOnly=!!L.top&&flg(L.top).includes('collar');
 const torso=(L.top&&!collarOnly)||(L.outer&&occ(L.outer).includes('top'));
 // owner 2026-10-26: an inner collar counts as the torso cover only for the parts whose measurement allows it (cat.collarCoversTop: the blazer, 20 of 21 test cells covered)
 const needers=(cat.needsTop||[]).filter(id=>worn.includes(id));
 if(needers.length&&!torso&&!(collarOnly&&needers.every(id=>(cat.collarCoversTop||[]).includes(id))))v.push('NEEDS_TOP');
 return v;
}

export function canonicalLook(L){return CANONICAL_PREFIX+';'+LOOK_FIELDS.map(k=>k+'='+(L[k]??'none')).join(';');}

/** Validates a look and returns its identity. lookKey = keccak256(utf8(canonical)). */
export function lookIdentity(look,cat=CATALOGUE){
 const L=normalizeLook(look,cat),rules=ruleViolations(L,cat);
 if(rules.length)fail('LOOK_RULE_'+rules[0]);
 const canonical=canonicalLook(L);
 return {look:L,canonical,lookKey:keccak256(toUtf8Bytes(canonical)),catalogueVersion:cat.version};
}

export function validChoice(choice){
 if(!Number.isInteger(choice)||choice<0||choice>CHOICE_RANDOM)fail('CHOICE_INVALID');
 return choice;
}
