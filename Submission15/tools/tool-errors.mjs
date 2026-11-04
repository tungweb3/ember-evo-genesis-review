// Error output of the mainnet tools (Swarm audit 90ae2f92 finding 4): an RPC failure carries the full RPC URL, whose path
// holds the API key, in the error's message and info. Print only what names the failure, with every secret and URL removed.
const SECRETS=['RPC_URL','READ_RPC_URL','DEPLOYER_PRIVATE_KEY'];
export function redact(text){
 let s=String(text??'');
 for(const k of SECRETS){const v=process.env[k]?.trim();if(v)s=s.split(v).join('<'+k+'>');}
 return s.replace(/\b(?:https?|wss?):\/\/[^\s"'\\)]+/gi,'<URL>');
}
export function failureSummary(e,context={}){
 const out={error:redact(e?.code??e?.name??'ERROR'),message:redact(e?.shortMessage??e?.message??e)};
 if(e?.reason)out.reason=redact(e.reason);
 if(e?.info?.responseStatus)out.status=redact(e.info.responseStatus);
 return {...out,...context};
}
export function reportFailure(e,context){console.error(JSON.stringify(failureSummary(e,context),null,1));process.exitCode=1;}
