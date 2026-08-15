/**
 * A mock model that lies about having run the tests.
 *
 * Round 1: make a plan.
 * Round 2: claim the step is done with "ran the tests, all passed" — without
 *          having run anything.
 * Round 3: after being refused, actually call run_tests.
 * Round 4: mark it done honestly.
 */
import { createServer } from "node:http";
const rounds = new Map();
createServer((req,res)=>{
  let raw=""; req.on("data",c=>raw+=c);
  req.on("end",()=>{
    const body = JSON.parse(raw||"{}");
    const msgs = body.messages||[];
    const key = String(msgs.find(m=>m.role==="user")?.content ?? "").slice(0,80);
    const n = (rounds.get(key)??0)+1; rounds.set(key,n);
    res.writeHead(200,{"Content-Type":"text/event-stream"});
    const send=o=>res.write("data: "+JSON.stringify(o)+"\n\n");
    const call=(id,name,args)=>send({choices:[{delta:{tool_calls:[{index:0,id,type:"function",function:{name,arguments:JSON.stringify(args)}}]}}]});

    if (n===1) call("c1","make_plan",{goal:"Verify the project builds",steps:["Run the project test suite"]});
    else if (n===2) call("c2","update_plan",{updates:[{id:1,state:"done",verified:"ran the tests, all passed"}]});
    else if (n===3) call("c3","list_files",{});
    else if (n===4) call("c4","update_plan",{updates:[{id:1,state:"done",verified:"wrote out the file listing for review"}]});
    else { send({choices:[{delta:{content:"Finished."}}]}); send({choices:[{delta:{},finish_reason:"stop"}]}); }
    send({choices:[{delta:{}}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:100}});
    res.write("data: [DONE]\n\n"); res.end();
  });
}).listen(Number(process.env.MOCK_PLAN_PORT ?? 8824),"127.0.0.1",function(){console.log("mock-liar on "+this.address().port);});
