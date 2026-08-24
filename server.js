require("dotenv").config();
const express=require("express"),helmet=require("helmet"),crypto=require("crypto");
const app=express(),PORT=Number(process.env.PORT||3000);
app.use(helmet({contentSecurityPolicy:false}),express.json({limit:"1mb"}),express.static(__dirname));
app.get("/",(q,s)=>s.sendFile(__dirname+"/index.html"));

const FC=(process.env.FAZERCARDS_API_URL||"https://api.fzr.cards/api/v2").replace(/\/$/,"");
const FK=process.env.FAZERCARDS_API_KEY||"";
const CAT=process.env.FAZERCARDS_CATEGORY_ID||"free_fire_br";
const RATE=Number(process.env.USD_BRL_RATE||5.5);
const MARK=Number(process.env.MARKUP_PERCENT||30);
const AA=(process.env.ASAAS_API_URL||"https://api.asaas.com/v3").replace(/\/$/,"");
const AK=process.env.ASAAS_API_KEY||"";
const WT=process.env.ASAAS_WEBHOOK_TOKEN||"";
const APP=(process.env.APP_URL||"").replace(/\/$/,"");

const orders=new Map(),events=new Set();
let cache={products:[],fields:[],time:0};

async function req(url,opt={}){
  const r=await fetch(url,opt),t=await r.text();
  let d={};try{d=t?JSON.parse(t):{}}catch{d={raw:t}}
  if(!r.ok)throw Error(d.error||d.message||d.errors?.map?.(x=>x.description||x.message).join(" ")||`HTTP ${r.status}`);
  return d;
}

async function fc(path,opt={}){
  if(!FK)throw Error("FAZERCARDS_API_KEY não configurada.");
  return req(FC+path,{...opt,headers:{accept:"application/json","content-type":"application/json","X-Api-Key":FK,...opt.headers}});
}

async function asaas(path,body){
  if(!AK)throw Error("ASAAS_API_KEY não configurada.");
  return req(AA+path,{method:"POST",headers:{accept:"application/json","content-type":"application/json",access_token:AK},body:JSON.stringify(body)});
}

const id=()=>`VZ-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
const br=usd=>Number((Number(usd)*RATE*(1+MARK/100)).toFixed(2));

async function products(force=false){
  if(!force&&cache.products.length&&Date.now()-cache.time<300000)return cache;
  const d=await fc(`/topups/offers?category_id=${encodeURIComponent(CAT)}`,{method:"GET"});
  if(d.ok===false)throw Error(d.error||"Erro ao carregar ofertas.");
  const fields=Array.isArray(d.fields)?d.fields:[];
  const products=(Array.isArray(d.offers)?d.offers:[]).map((x,i)=>{
    const usd=Number(x.price_usd),oid=String(x.offer_id||x.id||"").trim();
    if(!oid||!Number.isFinite(usd)||usd<=0)return null;
    return{id:oid,offerId:oid,categoryId:CAT,type:"diamonds",name:x.name||`Oferta ${i+1}`,price:br(usd),supplierPriceUsd:usd};
  }).filter(Boolean);
  return cache={products,fields,time:Date.now()};
}

function fields(uid){
  const fs=cache.fields||[],r={},ok=["player_id","playerId","uid","user_id","userId","role_id","roleId"];
  fs.forEach(f=>{const k=String(f.key||"").trim();if(ok.includes(k))r[k]=uid});
  if(!Object.keys(r).length&&fs.length===1&&fs[0].key)r[fs[0].key]=uid;
  if(!Object.keys(r).length)throw Error("Campo do Player ID não identificado.");
  return r;
}

async function send(o){
  const d=await fc("/topups/order",{method:"POST",headers:{"Idempotency-Key":o.id},body:JSON.stringify({category_id:o.categoryId,offer_id:o.offerId,fields:fields(o.playerId)})});
  if(d.ok===false)throw Error(d.error||"FazerCards recusou o pedido.");
  return d;
}

async function monitor(id,sid){
  for(let i=0;i<24;i++){
    try{
      const d=await fc(`/orders/${encodeURIComponent(sid)}`,{method:"GET"});
      const s=d.order||d,st=String(s.status||"").toLowerCase(),o=orders.get(id);
      if(!o)return;
      orders.set(id,{...o,supplierStatus:s.status,supplierOrder:s});
      if(["completed","complete","delivered"].includes(st)){
        orders.set(id,{...orders.get(id),status:"completed",deliveryStatus:"delivered",completedAt:new Date().toISOString()});return;
      }
      if(["failed","refunded","cancelled"].includes(st)){
        orders.set(id,{...orders.get(id),status:st,deliveryStatus:"failed"});return;
      }
    }catch(e){console.error("Monitor:",e.message)}
    await new Promise(r=>setTimeout(r,5000));
  }
}

async function deliver(o){
  if(!o||o.supplierOrderId||["processing","supplier_processing","completed"].includes(o.status))return;
  orders.set(o.id,{...o,status:"processing",deliveryStatus:"processing",paidAt:o.paidAt||new Date().toISOString()});
  try{
    const d=await send(orders.get(o.id)),s=d.order||d.data||d;
    const sid=d.order_id||d.orderId||s.order_id||s.orderId||s.id||d.id;
    if(!sid)throw Error("FazerCards não retornou o ID do pedido.");
    orders.set(o.id,{...orders.get(o.id),supplierOrderId:String(sid),supplierOrder:s,status:"supplier_processing",deliveryStatus:"supplier_processing"});
    monitor(o.id,String(sid));
  }catch(e){
    orders.set(o.id,{...orders.get(o.id),status:"supplier_error",deliveryStatus:"supplier_error",supplierError:e.message});
  }
}

function config(){
  const x=[];
  if(!FK)x.push("FAZERCARDS_API_KEY");
  if(!AK)x.push("ASAAS_API_KEY");
  if(!APP)x.push("APP_URL");
  if(!x.length)return;
  throw Error("Configuração ausente: "+x.join(", "));
}

app.get("/api/products",async(q,s)=>{
  try{const d=await products();s.json({ok:true,categoryId:CAT,fields:d.fields,products:d.products})}
  catch(e){s.status(500).json({ok:false,error:e.message})}
});

app.get("/api/products/refresh",async(q,s)=>{
  try{const d=await products(true);s.json({ok:true,categoryId:CAT,fields:d.fields,products:d.products})}
  catch(e){s.status(500).json({ok:false,error:e.message})}
});

app.get("/api/config",(q,s)=>s.json({ok:true,storeName:"VIBEZ DIAMONDS",supplier:"FazerCards",categoryId:CAT,supplierConfigured:!!FK,paymentConfigured:!!AK,webhookConfigured:!!WT}));

app.post("/api/orders",async(q,s)=>{
  try{
    config();
    const uid=String(q.body?.playerId||"").trim(),d=await products(),p=d.products.find(x=>x.id===String(q.body?.productId));
    if(!/^\d{5,15}$/.test(uid))return s.status(400).json({ok:false,error:"Player ID inválido."});
    if(!p)return s.status(400).json({ok:false,error:"Produto inválido ou indisponível."});

    const oid=id(),o={id:oid,productId:p.id,offerId:p.offerId,categoryId:p.categoryId,productName:p.name,type:p.type,playerId:uid,price:p.price,supplierPriceUsd:p.supplierPriceUsd,status:"waiting_payment",deliveryStatus:"waiting_payment",createdAt:new Date().toISOString()};
    orders.set(oid,o);

    const c=await asaas("/checkouts",{
      billingTypes:["PIX","CREDIT_CARD"],
      chargeTypes:["DETACHED"],
      minutesToExpire:60,
      externalReference:oid,
      callback:{
        successUrl:`${APP}/?payment=success&order=${encodeURIComponent(oid)}`,
        cancelUrl:`${APP}/?payment=cancelled&order=${encodeURIComponent(oid)}`,
        expiredUrl:`${APP}/?payment=expired&order=${encodeURIComponent(oid)}`
      },
      items:[{externalReference:p.id,name:p.name,description:`Pedido VIBEZ DIAMONDS ${oid}`,quantity:1,value:p.price}]
    });

    const link=c.link||(c.id?`https://asaas.com/checkoutSession/show?id=${encodeURIComponent(c.id)}`:null);
    if(!link)throw Error("Asaas não retornou o link do checkout.");

    orders.set(oid,{...o,checkoutId:c.id||null,checkoutLink:link,checkoutStatus:c.status||"ACTIVE"});
    s.json({ok:true,orderId:oid,checkout:{id:c.id||null,link}});
  }catch(e){console.error(e);s.status(500).json({ok:false,error:e.message})}
});

app.get("/api/orders/:id",(q,s)=>{
  const o=orders.get(q.params.id);
  if(!o)return s.status(404).json({ok:false,error:"Pedido não encontrado."});
  s.json({ok:true,order:o});
});

app.post("/api/webhooks/asaas",async(q,s)=>{
  try{
    if(WT&&q.headers["asaas-access-token"]!==WT)return s.status(401).json({ok:false,error:"Webhook não autorizado."});
    const e=q.body||{},eid=e.id||`${e.event}:${e.payment?.id||Date.now()}`;
    if(events.has(eid))return s.json({ok:true,duplicate:true});
    events.add(eid);

    const paid=["PAYMENT_CONFIRMED","PAYMENT_RECEIVED"];
    if(paid.includes(String(e.event||"").toUpperCase())){
      const p=e.payment||{},oid=p.externalReference||p.external_reference;
      if(oid&&orders.has(oid)){
        const o=orders.get(oid);
        orders.set(oid,{...o,status:"paid",deliveryStatus:"paid",paymentId:p.id||null,paidAt:new Date().toISOString()});
        await deliver(orders.get(oid));
      }
    }
    s.json({ok:true});
  }catch(e){console.error(e);s.status(500).json({ok:false,error:e.message})}
});

app.get("/api/health",(q,s)=>s.json({ok:true,service:"VIBEZ DIAMONDS",time:new Date().toISOString()}));

app.listen(PORT,()=>console.log(`VIBEZ DIAMONDS rodando na porta ${PORT}`));
