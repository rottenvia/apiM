// A mock model that makes a plan, does one step, then tries to stop early.
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

    if (n===1) call("c1","make_plan",{goal:"Do the whole thing properly",steps:["Do the first piece of work","Do the second piece of work","Do the third piece of work"]});
    else if (n===2) call("c2","update_plan",{updates:[{id:1,state:"done",verified:"ran it and saw the expected output"}]});
    else if (n===3) {
      // Stop early with a confident summary — the exact failure mode.
      send({choices:[{delta:{content:"All done! I have completed the task."}}]});
      send({choices:[{delta:{},finish_reason:"stop"}]});
    }
    else if (n===4) call("c4","update_plan",{updates:[{id:2,state:"done",verified:"ran it and saw the expected output"},{id:3,state:"done",verified:"ran the tests, all passed"}]});
    else { send({choices:[{delta:{content:"Now genuinely finished."}}]}); send({choices:[{delta:{},finish_reason:"stop"}]}); }
    send({choices:[{delta:{}}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:100}});
    res.write("data: [DONE]\n\n"); res.end();
  });
}).listen(Number(process.env.MOCK_PLAN_PORT ?? 8823),"127.0.0.1",function(){console.log("mock-plan on "+this.address().port);});
