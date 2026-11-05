// TEST ONLY: simulates MSAL cache identity and upstream proxy-lib, no network access.
import {writeFileSync,mkdirSync,readFileSync,existsSync} from 'node:fs';
import {dirname} from 'node:path';
export async function getToken(){
  const cache=process.env.M365_CACHE_FILE;
  if(process.env.M365_CONSOLE_REQUIRE_AUTOCREDS==='1'){
    const path=process.env.M365_SECRETS_FILE;
    if(!path||!existsSync(path))throw Error('Mock expected ephemeral auto credentials');
    const secret=JSON.parse(readFileSync(path,'utf8'));
    if(secret.email!==process.env.M365_EXPECTED_EMAIL||!secret.password||!secret.mfaSecret)throw Error('Mock auto credentials mismatch');
  }
  const email=process.env.M365_EXPECTED_EMAIL||'none@example.test';
  const tenant=process.env.M365_EXPECTED_TENANT||'test-tenant';
  mkdirSync(dirname(cache),{recursive:true,mode:0o700});
  writeFileSync(cache,JSON.stringify({Account:{test:{username:email,realm:tenant}}}),{mode:0o600});
  return 'fake-test-token-not-for-real-service';
}
export function createApp(){
  return {async fetch(req){
    const url=new URL(req.url);
    if(url.pathname==='/v1/models')return Response.json({object:'list',data:[{id:'gpt-test',object:'model'}]});
    if(url.pathname==='/v1/chat/completions'){
      const body=await req.json();
      const email=process.env.M365_EXPECTED_EMAIL;
      if(body.stream)return new Response('data: '+JSON.stringify({choices:[{delta:{content:email}}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
      return Response.json({choices:[{message:{role:'assistant',content:'AUTHORIZED:'+email}}]});
    }
    return Response.json({error:'not found'},{status:404});
  }};
}
