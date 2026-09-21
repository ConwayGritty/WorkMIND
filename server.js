import express from "express";
const app=express(); app.use(express.json({limit:"40mb"})); app.use(express.static("public"));
const PORT=process.env.PORT||3000, KEY=process.env.OPENROUTER_API_KEY;
const CHAT=process.env.WORKMIND_MODEL||"openai/gpt-oss-20b";
const STT=process.env.WORKMIND_TRANSCRIBE_MODEL||"openai/whisper-large-v3";
async function post(path,body){
 if(!KEY) throw new Error("OPENROUTER_API_KEY is not configured");
 const r=await fetch("https://openrouter.ai/api/v1"+path,{method:"POST",headers:{Authorization:`Bearer ${KEY}`,"Content-Type":"application/json","X-OpenRouter-Title":"WorkMind"},body:JSON.stringify(body)});
 const t=await r.text(); let j; try{j=JSON.parse(t)}catch{j={raw:t}}
 if(!r.ok) throw new Error(j?.error?.message||j?.message||`OpenRouter HTTP ${r.status}`); return j;
}
const schema={type:"object",properties:{tasks:{type:"array",items:{type:"object",properties:{
 title:{type:"string"},due:{type:["string","null"]},person:{type:["string","null"]},reason:{type:"string"},confidence:{type:"number",minimum:0,maximum:1}
},required:["title","due","person","reason","confidence"],additionalProperties:false}}},required:["tasks"],additionalProperties:false};
async function extract(transcript,context="",existingTasks=[]){
 const system=`You are WorkMind, a workplace commitment detector. Extract ONLY outstanding tasks the USER personally owns. Include work directly assigned to the user, requests the user explicitly accepts, and the user's explicit promises. Exclude tasks assigned to others, rejected requests, hypotheticals, suggestions, casual discussion, already-completed tasks, and duplicates. Resolve phrases like "I'll do that" using nearby context. Never invent details. Return only tasks with confidence >= 0.65.`;
 const j=await post("/chat/completions",{model:CHAT,messages:[{role:"system",content:system},{role:"user",content:`PRIOR CONTEXT:\n${context||"(none)"}\n\nEXISTING TASKS:\n${JSON.stringify(existingTasks)}\n\nNEW TRANSCRIPT:\n${transcript}`}],response_format:{type:"json_schema",json_schema:{name:"workmind_tasks",strict:true,schema}}});
 const c=j?.choices?.[0]?.message?.content; if(!c) throw new Error("No structured model response"); return typeof c==="string"?JSON.parse(c):c;
}
app.get("/api/health",(q,s)=>s.json({ok:true,version:"5.0.0",provider:"OpenRouter",apiKeyConfigured:Boolean(KEY),chatModel:CHAT,transcriptionModel:STT}));
app.post("/api/transcribe",async(q,s)=>{try{const {audioBase64,format="webm"}=q.body||{}; if(!audioBase64)return s.status(400).json({error:"audioBase64 required"}); const j=await post("/audio/transcriptions",{model:STT,input_audio:{data:audioBase64,format},language:"en",response_format:"json"});s.json({text:j.text||"",usage:j.usage||null})}catch(e){s.status(500).json({error:e.message})}});
app.post("/api/extract",async(q,s)=>{try{const {transcript="",context="",existingTasks=[]}=q.body||{};s.json(transcript.trim()?await extract(transcript,context,existingTasks):{tasks:[]})}catch(e){s.status(500).json({error:e.message})}});
app.post("/api/ask",async(q,s)=>{try{const {question="",transcript="",tasks=[]}=q.body||{};const j=await post("/chat/completions",{model:CHAT,messages:[{role:"system",content:"Answer only from the supplied WorkMind transcript and task list. If absent, say you do not have enough recorded information."},{role:"user",content:`TRANSCRIPT:\n${transcript}\nTASKS:\n${JSON.stringify(tasks)}\nQUESTION:\n${question}`} ]});s.json({answer:j?.choices?.[0]?.message?.content||""})}catch(e){s.status(500).json({error:e.message})}});
const cases=[
["accepted assignment",'Supervisor: "Please inspect Pump 12 before lunch." User: "Yep, I will do that."',1],
["rejected request",'Supervisor: "Can you inspect Pump 8?" User: "No, ask Mike."',0],
["coworker owns it",'Supervisor: "Mike, replace the filter before 3." User: "Sounds good."',0],
["pronoun commitment",'Supervisor: "We need the turnaround paperwork submitted today." User: "I will do that after lunch."',1],
["hypothetical",'User: "If Pump 4 acts up again, maybe we should inspect the seal."',0],
["already completed",'User: "I already checked the tank level this morning."',0],
["self commitment",'User: "I need to call maintenance about Valve 7 before end of shift."',1]];
app.get("/api/self-test",async(q,s)=>{if(!KEY)return s.status(503).json({apiKeyConfigured:false,error:"OPENROUTER_API_KEY is not configured"});try{
 const ping=await post("/chat/completions",{model:CHAT,messages:[{role:"user",content:"Reply exactly WORKMIND_OK"}],max_tokens:20});
 let passed=0,out=[];for(const [name,text,expected] of cases){try{const r=await extract(text),n=r.tasks?.length||0,ok=expected? n>=1:n===0;if(ok)passed++;out.push({name,expectedTasks:expected,actualTasks:n,pass:ok})}catch(e){out.push({name,expectedTasks:expected,pass:false,error:e.message})}}
 s.json({apiKeyConfigured:true,modelConnectivity:(ping?.choices?.[0]?.message?.content||"").includes("WORKMIND_OK"),benchmark:{passed,total:cases.length,cases:out}});
}catch(e){s.status(500).json({error:e.message})}});
app.listen(PORT,()=>console.log(`WorkMind V5 listening on ${PORT}`));
