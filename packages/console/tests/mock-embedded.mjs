// Test-only stand-in for the upstream proxy-lib; NEVER deployed with production credentials.
let sequence = 0;
export function createApp() {
  const poolId = ++sequence;
  let turns = 0;
  return {fetch:async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/v1/models') return Response.json({object:'list',data:[{id:'embedded-test',object:'model',context_window:1000000,max_output_tokens:100000}]});
    if (url.pathname === '/v1/chat/completions') {
      turns++;
      const b=await request.json();
      if (b.stream) {
        const payload='data: '+JSON.stringify({choices:[{delta:{content:`embedded-pool-${poolId}-turn-${turns}`}}]})+'\n\ndata: [DONE]\n\n';
        return new Response(payload,{status:200,headers:{'Content-Type':'text/event-stream'}});
      }
      return Response.json({id:'test-'+poolId,choices:[{message:{role:'assistant',content:`embedded-pool-${poolId}-turn-${turns}`}}],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}});
    }
    return new Response('Not found',{status:404});
  }};
}
