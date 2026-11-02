const nativeFetch=globalThis.fetch;let externalAttempts=0;
globalThis.fetch=(input,options)=>{
 const url=new URL(typeof input==='string'?input:input.url||input.href);
 if(!['127.0.0.1','localhost'].includes(url.hostname)){externalAttempts++;throw Error('SHARED_FIXTURE_EXTERNAL_REQUEST_DENIED');}
 return nativeFetch(input,options);
};
process.on('exit',()=>console.log(JSON.stringify({event:'shared_entrypoint_net_guard',externalAttempts})));
