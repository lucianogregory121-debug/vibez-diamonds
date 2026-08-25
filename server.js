require("dotenv").config();
const express=require("express"),helmet=require("helmet"),crypto=require("crypto");
const app=express(),PORT=Number(process.env.PORT||3000);
app.set("trust proxy",1);
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:"1mb"}));
app.use(express.static(__dirname));

const FC_URL=(process.env.FAZERCARDS_API_URL||"https://api.fzr.cards/api/v2").replace(/\/$/,"");
const FC_KEY=process.env.FAZERCARDS_API_KEY||"";
const FC_CATEGORY=process.env.FAZERCARDS_CATEGORY_ID||"free_fire_br";
const USD_BRL=Number(process.env.USD_BRL_RATE||5.5);
const MARKUP=Number(process.env.MARKUP_PERCENT||30);
const ASAAS_URL=(process.env.ASAAS_API_URL||"https://api.asaas.com/v3").replace(/\/$/,"");
const ASAAS_KEY=process.env.ASAAS_API_KEY||"";
const WEBHOOK_TOKEN=process.env.ASAAS_WEBHOOK_TOKEN||"";
const APP_URL=(process.env.APP_URL||"").replace(/\/$/,"");

const orders=new Map(),events=new Set();
let catalog={products:[],fields:[],loadedAt:0};

async function request(url,opt={}){
  const r=await fetch(url,opt),t=await r.text();
  let d={};try{d=t?JSON.parse(t):{}}catch{d={raw:t}}
  if(!r.ok)throw new Error(d.error||d.message||d.code||`HTTP ${r.status}`);
  return d;
}
async function fc(path,opt={}){
  if(!FC_KEY)throw new Error("FAZERCARDS_API_KEY não configurada.");
  return request(FC_URL+path,{...opt,headers:{
    accept:"application/json","content-type":"application/json",
    "X-Api-Key":FC_KEY,...(opt.headers||{})
  }});
}
async function asaas(path,body){
  if(!ASAAS_KEY)throw new Error("ASAAS_API_KEY não configurada.");
  return request(ASAAS_URL+path,{method:"POST",headers:{
    accept:"application/json","content-type":"application/json",
    access_token:ASAAS_KEY
  },body:JSON.stringify(body)});
}
function oid(){
  return "VZ-"+Date.now().toString(36).toUpperCase()+"-"+crypto.randomBytes(3).toString("hex").toUpperCase();
}
function price(v){
  v=Number(v);
  if(!Number.isFinite(v)||v<=0)throw new Error("Preço inválido do FazerCards.");
  return Number((v*USD_BRL*(1+MARKUP/100)).toFixed(2));
}
function fields(playerId){
  const f=catalog.fields||[],r={};
  const ok=["player_id","playerId","uid","user_id","userId","role_id","roleId"];
  f.forEach(x=>{
    const k=String(x.key||"").trim();
    if(ok.includes(k))r[k]=playerId;
  });
  if(!Object.keys(r).length&&f.length===1){
    const k=String(f[0].key||"").trim();
    if(k)r[k]=playerId;
  }
  if(!Object.keys(r).length)throw new Error("Campo de Player ID não encontrado.");
  return r;
}
async function loadProducts(force=false){
  const now=Date.now();
  if(!force&&catalog.products.length&&now-catalog.loadedAt<300000)return catalog;
  const d=await fc("/topups/offers?category_id="+encodeURIComponent(FC_CATEGORY));
  if(d.ok===false)throw new Error(d.error||"Erro nas ofertas.");
  const offers=Array.isArray(d.offers)?d.offers:[];
  catalog={
    fields:Array.isArray(d.fields)?d.fields:[],
    products:offers.map((o,i)=>{
      const usd=Number(o.price_usd),id=String(o.offer_id||o.id||"").trim();
      if(!id||!Number.isFinite(usd)||usd<=0)return null;
      return{
        id,offerId:id,categoryId:FC_CATEGORY,type:"diamonds",
        name:o.name||`Oferta ${i+1}`,price:price(usd),
        supplierPriceUsd:usd,requires:"playerId"
      };
    }).filter(Boolean),loadedAt:now
  };
  console.log("FazerCards:",catalog.products.length,"ofertas.");
  return catalog;
}
async function sendOrder(o){
  const d=await fc("/topups/order",{
    method:"POST",
    headers:{"Idempotency-Key":o.id},
    body:JSON.stringify({
      category_id:o.categoryId,
      offer_id:o.offerId,
      fields:fields(o.playerId)
    })
  });
  if(d.ok===false)throw new Error(d.error||"FazerCards recusou o pedido.");
  return d;
}
async function monitor(id,sid){
  for(let i=0;i<24;i++){
    try{
      const d=await fc("/orders/"+encodeURIComponent(sid));
      const s=d.order||d,o=orders.get(id);
      if(!o)return;
      const st=String(s.status||"").toLowerCase();
      if(["completed","complete","delivered"].includes(st)){
        orders.set(id,{...o,supplierStatus:s.status,supplierOrder:s,
          status:"completed",deliveryStatus:"delivered",
          completedAt:new Date().toISOString()});return;
      }
      if(["failed","refunded","cancelled"].includes(st)){
        orders.set(id,{...o,supplierStatus:s.status,supplierOrder:s,
          status:st,deliveryStatus:"failed"});return;
      }
      orders.set(id,{...o,supplierStatus:s.status,supplierOrder:s});
    }catch(e){console.error("Monitor:",e.message)}
    await new Promise(r=>setTimeout(r,5000));
  }
}
async function deliver(o){
  const cur=orders.get(o.id);
  if(!cur||cur.supplierOrderId)return;
  orders.set(o.id,{...cur,status:"processing",deliveryStatus:"processing",
    paidAt:cur.paidAt||new Date().toISOString()});
  try{
    const d=await sendOrder(cur),s=d.order||d.data||d;
    const sid=d.order_id||d.orderId||s.order_id||s.orderId||s.id||d.id;
    if(!sid)throw new Error("FazerCards não retornou ID do pedido.");
    orders.set(o.id,{...orders.get(o.id),supplierOrderId:String(sid),
      supplierOrder:s,status:"supplier_processing",
      deliveryStatus:"supplier_processing",
      supplierCreatedAt:new Date().toISOString()});
    monitor(o.id,String(sid)).catch(e=>console.error("Monitor:",e.message));
  }catch(e){
    console.error("FazerCards:",e.message);
    orders.set(o.id,{...orders.get(o.id),status:"supplier_error",
      deliveryStatus:"supplier_error",supplierError:e.message});
  }
}

/* PRODUTOS */
app.get("/api/products",async(req,res)=>{
  try{
    const d=await loadProducts();
    res.json({ok:true,categoryId:FC_CATEGORY,fields:d.fields,products:d.products});
  }catch(e){res.status(500).json({ok:false,error:e.message})}
});
app.get("/api/products/refresh",async(req,res)=>{
  try{
    const d=await loadProducts(true);
    res.json({ok:true,categoryId:FC_CATEGORY,fields:d.fields,products:d.products,count:d.products.length});
  }catch(e){res.status(500).json({ok:false,error:e.message})}
});

/* CONFIG */
app.get("/api/config",(req,res)=>res.json({
  ok:true,storeName:"VIBEZ DIAMONDS",supplier:"FazerCards",
  categoryId:FC_CATEGORY,supplierConfigured:!!FC_KEY,
  paymentConfigured:!!ASAAS_KEY,webhookConfigured:!!WEBHOOK_TOKEN
}));

/* PEDIDO */
app.post("/api/orders",async(req,res)=>{
  try{
    if(!FC_KEY||!ASAAS_KEY)throw new Error("Configure as chaves da FazerCards e Asaas.");
    const pid=String(req.body?.playerId||"").trim();
    if(!/^\d{5,15}$/.test(pid))
      return res.status(400).json({ok:false,error:"Player ID inválido."});

    const d=await loadProducts();
    const p=d.products.find(x=>x.id===String(req.body?.productId));
    if(!p)return res.status(400).json({ok:false,error:"Produto inválido ou indisponível."});

    const id=oid();
    const o={
      id,productId:p.id,offerId:p.offerId,categoryId:p.categoryId,
      productName:p.name,type:p.type,playerId:pid,
      supplierPriceUsd:p.supplierPriceUsd,price:p.price,
      status:"waiting_payment",deliveryStatus:"waiting_payment",
      createdAt:new Date().toISOString()
    };
    orders.set(id,o);

    const c=await asaas("/checkouts",{
      billingTypes:["PIX","CREDIT_CARD"],
      chargeTypes:["DETACHED"],
      minutesToExpire:60,
      externalReference:id,
      callback:{
        successUrl:`${APP_URL}/?payment=success&order=${encodeURIComponent(id)}`,
        cancelUrl:`${APP_URL}/?payment=cancelled&order=${encodeURIComponent(id)}`,
        expiredUrl:`${APP_URL}/?payment=expired&order=${encodeURIComponent(id)}`
      },
      items:[{
        externalReference:p.id,name:p.name,
        description:`Pedido VIBEZ DIAMONDS ${id}`,
        quantity:1,value:p.price
      }]
    });

    const link=c.link||(c.id?`https://asaas.com/checkoutSession/show?id=${encodeURIComponent(c.id)}`:null);
    if(!link)throw new Error("Asaas não retornou o link.");

    orders.set(id,{...o,checkoutId:c.id||null,checkoutLink:link,
      checkoutStatus:c.status||"ACTIVE"});

    res.json({ok:true,orderId:id,checkout:{id:c.id||null,link}});
  }catch(e){
    console.error("Pedido:",e.message);
    res.status(500).json({ok:false,error:e.message});
  }
});

/* CONSULTAR */
app.get("/api/orders/:id",(req,res)=>{
  const o=orders.get(req.params.id);
  if(!o)return res.status(404).json({ok:false,error:"Pedido não encontrado."});
  res.json({ok:true,order:o});
});

/* WEBHOOK */
app.post("/api/webhooks/asaas",async(req,res)=>{
  try{
    if(WEBHOOK_TOKEN&&req.headers["asaas-access-token"]!==WEBHOOK_TOKEN)
      return res.status(401).json({ok:false,error:"Webhook não autorizado."});

    const e=req.body||{},eid=e.id||`${e.event}:${e.payment?.id||Date.now()}`;
    if(events.has(eid))return res.json({ok:true,duplicate:true});
    events.add(eid);

    const p=e.payment||{},ev=String(e.event||"").toUpperCase();
    if(["PAYMENT_CONFIRMED","PAYMENT_RECEIVED"].includes(ev)){
      const id=p.externalReference||p.external_reference;
      if(id&&orders.has(id)){
        const o=orders.get(id);
        orders.set(id,{...o,status:"paid",deliveryStatus:"paid",
          paymentId:p.id||null,paidAt:new Date().toISOString()});
        await deliver(orders.get(id));
      }
    }
    res.json({ok:true});
  }catch(e){
    console.error("Webhook:",e.message);
    res.status(500).json({ok:false,error:e.message});
  }
});

/* HEALTH */
app.get("/api/health",(req,res)=>res.json({
  ok:true,service:"VIBEZ DIAMONDS",categoryId:FC_CATEGORY,
  time:new Date().toISOString()
}));

app.get("/",(req,res)=>res.sendFile(__dirname+"/index.html"));
app.use((e,req,res,next)=>{
  console.error(e);
  res.status(500).json({ok:false,error:"Erro interno do servidor."});
});

if(!process.env.VERCEL)app.listen(PORT,()=>console.log(
  `VIBEZ DIAMONDS | porta ${PORT} | categoria ${FC_CATEGORY}`
));

module.exports=app;
