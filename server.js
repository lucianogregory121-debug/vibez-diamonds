server.js — VIBEZ DIAMONDS compacto

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
const USD=Number(process.env.USD_BRL_RATE||5.5);
const MARKUP=Number(process.env.MARKUP_PERCENT||30);
const AS_URL=(process.env.ASAAS_API_URL||"https://api.asaas.com/v3").replace(/\/$/,"");
const AS_KEY=process.env.ASAAS_API_KEY||"";
const WH_TOKEN=process.env.ASAAS_WEBHOOK_TOKEN||"";
const APP_URL=(process.env.APP_URL||"").replace(/\/$/,"");

const orders=new Map(),events=new Set();
let catalog={products:[],fields:[],time:0};

app.get("/",(q,s)=>s.sendFile(__dirname+"/index.html"));

async function request(url,opt={}){
  const r=await fetch(url,opt),t=await r.text();
  let d={};try{d=t?JSON.parse(t):{}}catch{d={raw:t}}
  if(!r.ok){
    const e=d?.error||d?.message||d?.errors?.map?.(x=>x.description||x.message||x).join(" ")||`HTTP ${r.status}`;
    throw Error(e);
  }
  return d;
}

async function fc(path,opt={}){
  if(!FC_KEY)throw Error("FAZERCARDS_API_KEY não configurada.");
  return request(FC_URL+path,{
    ...opt,
    headers:{
      accept:"application/json",
      "content-type":"application/json",
      "X-Api-Key":FC_KEY,
      ...(opt.headers||{})
    }
  });
}

async function asaas(path,body){
  if(!AS_KEY)throw Error("ASAAS_API_KEY não configurada.");
  return request(AS_URL+path,{
    method:"POST",
    headers:{
      accept:"application/json",
      "content-type":"application/json",
      access_token:AS_KEY
    },
    body:JSON.stringify(body)
  });
}

const id=()=>`VZ-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

function price(v){
  v=Number(v);
  if(!Number.isFinite(v)||v<=0)throw Error("Preço inválido recebido do FazerCards.");
  return Number((v*USD*(1+MARKUP/100)).toFixed(2));
}

async function products(force=false){
  if(!force&&catalog.products.length&&Date.now()-catalog.time<300000)return catalog;

  const d=await fc(`/topups/offers?category_id=${encodeURIComponent(FC_CATEGORY)}`);
  if(d.ok===false)throw Error(d.error||"Erro ao buscar ofertas.");

  const fields=Array.isArray(d.fields)?d.fields:[];
  const offers=Array.isArray(d.offers)?d.offers:[];

  const ps=offers.map((o,i)=>{
    const usd=Number(o.price_usd),oid=String(o.offer_id||o.id||"").trim();
    if(!oid||!Number.isFinite(usd)||usd<=0)return null;
    return{
      id:oid,offerId:oid,categoryId:FC_CATEGORY,type:"diamonds",
      name:o.name||`Oferta ${i+1}`,price:price(usd),
      supplierPriceUsd:usd,requires:"playerId"
    };
  }).filter(Boolean);

  catalog={products:ps,fields,time:Date.now()};
  console.log("FazerCards:",ps.length,"ofertas");
  return catalog;
}

function fieldsFor(playerId){
  const fs=catalog.fields||[];
  if(!fs.length)return{player_id:playerId};

  const ok=[
    "player_id","playerId","uid","user_id","userId",
    "role_id","roleId","playerID","userid"
  ];

  const out={};
  for(const f of fs){
    const k=String(f.key||"").trim();
    if(ok.includes(k))out[k]=playerId;
  }

  if(!Object.keys(out).length&&fs.length===1){
    const k=String(fs[0].key||"").trim();
    if(k)out[k]=playerId;
  }

  return Object.keys(out).length?out:{player_id:playerId};
}

/*
  IMPORTANTE:
  Algumas categorias do FazerCards não possuem validação de ID.
  Nesse caso o endpoint retorna:
  "ID validation is not available for this category_id."

  Isso NÃO deve impedir o cliente de pagar.
*/
async function validate(playerId){
  try{
    const d=await fc("/topups/validate-id",{
      method:"POST",
      headers:{"Idempotency-Key":crypto.randomUUID()},
      body:JSON.stringify({
        category_id:FC_CATEGORY,
        fields:fieldsFor(playerId)
      })
    });

    return{
      available:true,
      valid:d.valid!==false,
      playerName:d.player_name||null,
      region:d.region||null
    };
  }catch(e){
    const m=String(e.message||"").toLowerCase();

    if(
      m.includes("validation is not available")||
      m.includes("id validation is not available")||
      m.includes("not available for this category")
    ){
      console.log("FazerCards: validação de ID indisponível; seguindo para pagamento.");
      return{available:false,valid:true,playerName:null,region:null};
    }

    throw e;
  }
}

async function send(order){
  const d=await fc("/topups/order",{
    method:"POST",
    headers:{"Idempotency-Key":order.id},
    body:JSON.stringify({
      category_id:order.categoryId,
      offer_id:order.offerId,
      fields:fieldsFor(order.playerId)
    })
  });

  if(d.ok===false)throw Error(d.error||"FazerCards recusou o pedido.");
  return d;
}

async function monitor(orderId,sid){
  for(let i=0;i<24;i++){
    try{
      const d=await fc(`/orders/${encodeURIComponent(sid)}`);
      const o=d.order||d,st=String(o.status||"").toLowerCase();
      const cur=orders.get(orderId);
      if(!cur)return;

      if(["completed","complete","delivered"].includes(st)){
        orders.set(orderId,{
          ...cur,supplierStatus:o.status,supplierOrder:o,
          status:"completed",deliveryStatus:"delivered",
          completedAt:new Date().toISOString()
        });
        return;
      }

      if(["failed","refunded","cancelled"].includes(st)){
        orders.set(orderId,{
          ...cur,supplierStatus:o.status,supplierOrder:o,
          status:st,deliveryStatus:"failed"
        });
        return;
      }

      orders.set(orderId,{...cur,supplierStatus:o.status,supplierOrder:o});
    }catch(e){
      console.error("Monitor FazerCards:",e.message);
    }

    await new Promise(r=>setTimeout(r,5000));
  }
}

async function deliver(order){
  const cur=orders.get(order.id);
  if(!cur)return;

  if(cur.supplierOrderId||
    ["processing","supplier_processing","completed"].includes(cur.status)
  )return;

  orders.set(order.id,{
    ...cur,status:"processing",deliveryStatus:"processing",
    paidAt:cur.paidAt||new Date().toISOString()
  });

  try{
    const d=await send(orders.get(order.id));
    const o=d.order||d.data||d;

    const sid=
      d.order_id||d.orderId||
      o?.order_id||o?.orderId||
      o?.id||d.id;

    if(!sid)throw Error("FazerCards não retornou o ID do pedido.");

    orders.set(order.id,{
      ...orders.get(order.id),
      supplierOrderId:String(sid),
      supplierOrder:o,
      status:"supplier_processing",
      deliveryStatus:"supplier_processing",
      supplierCreatedAt:new Date().toISOString()
    });

    console.log("Pedido enviado:",order.id,String(sid));
    monitor(order.id,String(sid)).catch(e=>console.error("Monitor:",e.message));

  }catch(e){
    console.error("Erro FazerCards:",e.message);
    orders.set(order.id,{
      ...orders.get(order.id),
      status:"supplier_error",
      deliveryStatus:"supplier_error",
      supplierError:e.message,
      supplierErrorAt:new Date().toISOString()
    });
  }
}

/* PRODUTOS */
app.get("/api/products",async(q,s)=>{
  try{
    const d=await products();
    s.json({ok:true,categoryId:FC_CATEGORY,fields:d.fields,products:d.products});
  }catch(e){s.status(500).json({ok:false,error:e.message})}
});

app.get("/api/products/refresh",async(q,s)=>{
  try{
    const d=await products(true);
    s.json({ok:true,products:d.products,fields:d.fields,count:d.products.length});
  }catch(e){s.status(500).json({ok:false,error:e.message})}
});

/* CONFIG */
app.get("/api/config",(q,s)=>s.json({
  ok:true,
  storeName:"VIBEZ DIAMONDS",
  supplier:"FazerCards",
  categoryId:FC_CATEGORY,
  supplierConfigured:!!FC_KEY,
  paymentConfigured:!!AS_KEY,
  webhookConfigured:!!WH_TOKEN
}));

/* CRIAR PEDIDO */
app.post("/api/orders",async(q,s)=>{
  try{
    if(!FC_KEY||!AS_KEY||!APP_URL)
      throw Error("Configure FAZERCARDS_API_KEY, ASAAS_API_KEY e APP_URL.");

    const body=q.body||{};
    const playerId=String(body.playerId||"").trim();
    const productId=String(body.productId||"").trim();

    if(!/^\d{5,15}$/.test(playerId))
      return s.status(400).json({ok:false,error:"Player ID inválido."});

    const d=await products();
    const p=d.products.find(x=>x.id===productId);

    if(!p)
      return s.status(400).json({ok:false,error:"Produto inválido ou indisponível."});

    let v;
    try{
      v=await validate(playerId);
    }catch(e){
      return s.status(400).json({
        ok:false,
        error:"Não foi possível validar o Player ID: "+e.message
      });
    }

    if(v.valid===false)
      return s.status(400).json({ok:false,error:"Player ID inválido no FazerCards."});

    const oid=id();

    const order={
      id:oid,
      productId:p.id,
      offerId:p.offerId,
      categoryId:p.categoryId,
      productName:p.name,
      type:p.type,
      playerId,
      playerName:v.playerName,
      region:v.region,
      validationAvailable:v.available,
      supplierPriceUsd:p.supplierPriceUsd,
      price:p.price,
      status:"waiting_payment",
      deliveryStatus:"waiting_payment",
      createdAt:new Date().toISOString()
    };

    orders.set(oid,order);

    const checkout=await asaas("/checkouts",{
      billingTypes:["PIX","CREDIT_CARD"],
      chargeTypes:["DETACHED"],
      minutesToExpire:60,
      externalReference:oid,
      callback:{
        successUrl:`${APP_URL}/?payment=success&order=${encodeURIComponent(oid)}`,
        cancelUrl:`${APP_URL}/?payment=cancelled&order=${encodeURIComponent(oid)}`,
        expiredUrl:`${APP_URL}/?payment=expired&order=${encodeURIComponent(oid)}`
      },
      items:[{
        externalReference:p.id,
        name:p.name,
        description:`Pedido VIBEZ DIAMONDS ${oid}`,
        quantity:1,
        value:p.price
      }]
    });

    const link=checkout.link||
      (checkout.id?
       `https://asaas.com/checkoutSession/show?id=${encodeURIComponent(checkout.id)}`
       :null);

    if(!link)throw Error("Asaas não retornou o link do checkout.");

    orders.set(oid,{
      ...order,
      checkoutId:checkout.id||null,
      checkoutLink:link,
      checkoutStatus:checkout.status||"ACTIVE"
    });

    s.json({
      ok:true,
      orderId:oid,
      checkout:{id:checkout.id||null,link}
    });

  }catch(e){
    console.error("Criar pedido:",e);
    s.status(500).json({ok:false,error:e.message||"Erro ao criar pagamento."});
  }
});

/* CONSULTAR PEDIDO */
app.get("/api/orders/:id",(q,s)=>{
  const o=orders.get(q.params.id);
  if(!o)return s.status(404).json({ok:false,error:"Pedido não encontrado."});
  s.json({ok:true,order:o});
});

/* WEBHOOK ASAAS */
app.post("/api/webhooks/asaas",async(q,s)=>{
  try{
    if(WH_TOKEN&&q.headers["asaas-access-token"]!==WH_TOKEN)
      return s.status(401).json({ok:false,error:"Webhook não autorizado."});

    const e=q.body||{};
    const eid=e.id||`${e.event||"event"}:${e.payment?.id||Date.now()}`;

    if(events.has(eid))return s.json({ok:true,duplicate:true});
    events.add(eid);

    const p=e.payment||{};
    const name=String(e.event||"").toUpperCase();

    if(["PAYMENT_CONFIRMED","PAYMENT_RECEIVED"].includes(name)){
      const oid=p.externalReference||p.external_reference;

      if(oid&&orders.has(oid)){
        const o=orders.get(oid);

        orders.set(oid,{
          ...o,
          status:"paid",
          deliveryStatus:"paid",
          paymentId:p.id||null,
          paidAt:new Date().toISOString()
        });

        await deliver(orders.get(oid));
      }
    }

    s.json({ok:true});
  }catch(e){
    console.error("Webhook:",e);
    s.status(500).json({ok:false,error:e.message});
  }
});

/* HEALTH */
app.get("/api/health",(q,s)=>s.json({
  ok:true,
  service:"VIBEZ DIAMONDS",
  time:new Date().toISOString()
}));

app.use((e,q,s,n)=>{
  console.error(e);
  s.status(500).json({ok:false,error:"Erro interno do servidor."});
});

app.listen(PORT,()=>{
  console.log("=================================");
  console.log("VIBEZ DIAMONDS");
  console.log("Porta:",PORT);
  console.log("FazerCards:",FC_KEY?"OK":"NÃO CONFIGURADO");
  console.log("Asaas:",AS_KEY?"OK":"NÃO CONFIGURADO");
  console.log("=================================");
});
