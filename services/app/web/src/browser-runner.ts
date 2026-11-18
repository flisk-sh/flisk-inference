// The runner page for models that run in the visitor's tab (see browser-models.ts). Flisk apps put it in a hidden iframe:
//   <iframe src="https://inference.flisk.si/browser-model" allow="webgpu" hidden></iframe>
// and talk to it with postMessage. It lives here, on inference's own origin, so the engine and the model's weights never run
// in the app's page: an app's cookies and session stay out of reach of third-party code (the engine comes from a CDN, pinned).
//
//   app -> runner   { cmd: "status" }
//                   { cmd: "generate", id, model, messages: [{ role, content }], maxTokens }
//                   { cmd: "stop" }
//   runner -> app   { from: "flisk-browser-model", ev: "ready", webgpu, models }
//                   { ..., id, ev: "progress", progress: 0..1, text }   while the weights load (about 0.3-1 GB, once, then cached)
//                   { ..., id, ev: "delta", text }                       each piece of the answer as it is written
//                   { ..., id, ev: "done", text } | { ..., id, ev: "error", error }
//
// Only a *.flisk.si page (or localhost, for development) is answered, and only for a model named in /v1/browser-models.
import { BROWSER_ENGINE } from "./browser-models";

export const RUNNER_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' https://esm.run https://cdn.jsdelivr.net; " +
  "connect-src 'self' https://esm.run https://cdn.jsdelivr.net https://huggingface.co https://*.huggingface.co https://*.hf.co https://raw.githubusercontent.com; " +
  "worker-src blob:; form-action 'none'; base-uri 'none'; frame-ancestors https://*.flisk.si http://localhost:* http://127.0.0.1:*";

export const MAX_MESSAGES = 8;
export const MAX_CONTENT = 12000;
export const MAX_ANSWER_TOKENS = 1024;

export function runnerHtml(): string {
  return `<!doctype html><meta charset="utf-8"><title>Flisk browser model</title>
<script type="module">
var ENGINE=${JSON.stringify(BROWSER_ENGINE.url)};
var FROM="flisk-browser-model";
var OK=/^https:\\/\\/([a-z0-9-]+\\.)*flisk\\.si$|^http:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d+)?$/;
var engine=null,loaded="",busy=false,list=null,webllm=null;
function send(to,o){parent.postMessage(Object.assign({from:FROM},o),to)}
async function models(){if(!list)list=(await (await fetch("/v1/browser-models")).json()).data||[];return list}
async function gpu(){try{return !!(navigator.gpu&&await navigator.gpu.requestAdapter())}catch(e){return false}}
function clean(messages){
  if(!Array.isArray(messages)||!messages.length||messages.length>${MAX_MESSAGES})return null;
  var out=[];
  for(var i=0;i<messages.length;i++){var m=messages[i];
    if(!m||typeof m.content!=="string"||m.content.length>${MAX_CONTENT}||["system","user","assistant"].indexOf(m.role)<0)return null;
    out.push({role:m.role,content:m.content})}
  return out}
addEventListener("message",async function(e){
  if(!OK.test(e.origin)||e.source!==parent)return;
  var m=e.data||{},to=e.origin;
  if(m.cmd==="status"){send(to,{ev:"ready",webgpu:await gpu(),models:(await models()).map(function(x){return x.id})});return}
  if(m.cmd==="stop"){try{if(engine)engine.interruptGenerate()}catch(x){}return}
  if(m.cmd!=="generate")return;
  var id=String(m.id||"").slice(0,40);
  var fail=function(t){send(to,{id:id,ev:"error",error:t})};
  if(busy)return fail("the model is already writing an answer");
  var def=(await models()).find(function(x){return x.model===m.model||x.id===m.model});
  var msgs=clean(m.messages);
  if(!def)return fail("that model is not one inference serves for the browser");
  if(!msgs)return fail("the messages are not valid");
  if(!(await gpu()))return fail("this browser has no WebGPU");
  busy=true;
  try{
    if(!webllm)webllm=await import(ENGINE);
    if(loaded!==def.model){
      engine=await webllm.CreateMLCEngine(def.model,{initProgressCallback:function(r){send(to,{id:id,ev:"progress",progress:Number(r.progress)||0,text:String(r.text||"").slice(0,120)})}});
      loaded=def.model}
    var chunks=await engine.chat.completions.create({messages:msgs,stream:true,temperature:0.2,max_tokens:Math.min(Number(m.maxTokens)||512,${MAX_ANSWER_TOKENS})});
    var text="";
    for await(var c of chunks){var d=c.choices&&c.choices[0]&&c.choices[0].delta&&c.choices[0].delta.content;if(d){text+=d;send(to,{id:id,ev:"delta",text:d})}}
    send(to,{id:id,ev:"done",text:text})
  }catch(x){fail(String(x&&x.message||x).slice(0,200))}
  finally{busy=false}
});
(async function(){var o=document.referrer?new URL(document.referrer).origin:"";if(OK.test(o))send(o,{ev:"ready",webgpu:await gpu(),models:(await models()).map(function(x){return x.id})})})();
</script>`;
}

export const runnerResponse = (): Response =>
  new Response(runnerHtml(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": RUNNER_CSP } });
