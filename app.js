let catalog=[],selected=null,orderId=null;
const money=v=>new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(v);

async function load(){
  try{
    const r=await fetch("/api/config"),d=await r.json();
    catalog=d.catalog||[];
    document.getElementById("mode").textContent =
      d.paymentConfigured&&d.providerConfigured
      ? "Integrações configuradas"
      : "Modo preparação";
    render();
  }catch{
    document.getElementById("mode").textContent="Servidor offline";
  }
}

function render(){
  const box=document.getElementById("products");
  box.innerHTML="";
  catalog.forEach(p=>{
    const b=document.createElement("button");
    b.type="button";
    b.className="product";
    b.innerHTML=`${p.popular?'<span class="popular">MAIS VENDIDO</span>':""}
      <div class="dia">💎</div>
      <h3>${p.diamonds.toLocaleString("pt-BR")} diamantes</h3>
      <p>Recarga para o ID do jogador</p>
      <div class="price">${money(p.price)}</div>`;
    b.onclick=()=>select(p,b);
    box.appendChild(b);
  });
}

function select(p,b){
  selected=p;
  document.querySelectorAll(".product").forEach(x=>x.classList.remove("active"));
  b.classList.add("active");
  document.getElementById("sumDiamonds").textContent=p.label;
  document.getElementById("sumProduct").textContent=p.label;
  document.getElementById("sumPrice").textContent=money(p.price);
  updatePlayer();
}

function updatePlayer(){
  const id=document.getElementById("playerId").value.trim();
  document.getElementById("sumPlayer").textContent=id?`ID: ${id}`:"ID não informado";
}
document.getElementById("playerId").addEventListener("input",updatePlayer);

document.getElementById("checkout").onclick=async()=>{
  const notice=document.getElementById("notice");
  notice.textContent="";
  if(!selected){notice.textContent="Escolha um pacote.";return;}
  const playerId=document.getElementById("playerId").value.trim();
  if(!/^[0-9]{5,20}$/.test(playerId)){
    notice.textContent="Digite um ID numérico válido.";
    return;
  }
  const btn=document.getElementById("checkout");
  btn.disabled=true;btn.textContent="Criando pedido...";
  try{
    const r=await fetch("/api/orders",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({productId:selected.id,playerId,paymentMethod:"pix"})
    });
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||"Erro");
    orderId=d.order.id;
    document.getElementById("orderStatus").textContent="Pedido criado — aguardando pagamento.";
    document.getElementById("orderId").textContent="Pedido: "+orderId;
    notice.textContent="Nenhuma cobrança foi feita. O PIX real será ativado quando o gateway for conectado.";
  }catch(e){
    notice.textContent=e.message;
  }finally{
    btn.disabled=false;btn.textContent="Criar pedido";
  }
};

load();
