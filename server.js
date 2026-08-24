require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

const ASAAS_API_URL =
  process.env.ASAAS_API_URL || "https://api.asaas.com/v3";

/*
  Pedidos em memória.

  IMPORTANTE:
  Para produção definitiva, recomendamos colocar os pedidos
  em PostgreSQL/Supabase. O Map funciona para esta etapa de
  testes, mas pode ser perdido quando o servidor reiniciar.
*/
const orders = new Map();

/*
  Eventos já processados.
  O Asaas trabalha com entrega "at least once", então o mesmo
  evento pode chegar mais de uma vez.
*/
const processedWebhookEvents = new Set();

const products = [
  { id: "d100", diamonds: 100, price: 5.00 },
  { id: "d310", diamonds: 310, price: 12.99 },
  { id: "d520", diamonds: 520, price: 19.99 },
  { id: "d1060", diamonds: 1060, price: 39.99 },
  { id: "d2180", diamonds: 2180, price: 79.99 },
  { id: "d5600", diamonds: 5600, price: 199.99 }
];

/* =========================
   CONFIGURAÇÃO
========================= */

function asaasConfigured() {
  return Boolean(process.env.ASAAS_API_KEY);
}

function webhookConfigured() {
  return Boolean(process.env.ASAAS_WEBHOOK_TOKEN);
}

function getBaseUrl(req) {
  return (
    process.env.PUBLIC_URL ||
    `${req.protocol}://${req.get("host")}`
  ).replace(/\/$/, "");
}

/* =========================
   ASAAS API
========================= */

async function asaasRequest(endpoint, options = {}) {
  if (!process.env.ASAAS_API_KEY) {
    throw new Error(
      "ASAAS_API_KEY não configurada no Render."
    );
  }

  const response = await fetch(
    `${ASAAS_API_URL}${endpoint}`,
    {
      ...options,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        access_token: process.env.ASAAS_API_KEY,
        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();

  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    console.error(
      "Erro Asaas:",
      response.status,
      data
    );

    const message =
      data?.errors
        ?.map?.(e => e.description)
        .join(" ") ||
      data?.message ||
      "Erro retornado pelo Asaas.";

    throw new Error(message);
  }

  return data;
}

/* =========================
   CONFIG
========================= */

app.get("/api/config", (_, res) => {
  res.json({
    storeName:
      process.env.STORE_NAME ||
      "VIBEZ DIAMONDS",

    asaasConfigured:
      asaasConfigured(),

    webhookConfigured:
      webhookConfigured(),

    supplierConfigured:
      Boolean(
        process.env.SUPPLIER_API_URL &&
        process.env.SUPPLIER_API_KEY
      )
  });
});

/* =========================
   PRODUTOS
========================= */

app.get("/api/products", (_, res) => {
  res.json({
    products
  });
});

/* =========================
   CONSULTAR PEDIDO
========================= */

app.get("/api/orders/:orderId", (req, res) => {
  const orderId =
    String(req.params.orderId || "").trim();

  const order = orders.get(orderId);

  if (!order) {
    return res.status(404).json({
      error: "Pedido não encontrado."
    });
  }

  res.json({
    ok: true,
    order: {
      id: order.id,
      playerId: order.playerId,
      productId: order.productId,
      diamonds: order.diamonds,
      price: order.price,
      paymentMethod: order.paymentMethod,
      status: order.status,
      checkoutId: order.checkoutId || null,
      paymentId: order.paymentId || null,
      updatedAt: order.updatedAt
    }
  });
});

/* =========================
   CRIAR PEDIDO + CHECKOUT
========================= */

app.post("/api/orders", async (req, res) => {
  try {
    const {
      playerId,
      productId,
      paymentMethod,

      customerName,
      customerEmail,
      customerCpfCnpj,
      customerPhone
    } = req.body;

    /* ---------- validações ---------- */

    if (
      !playerId ||
      !productId ||
      !paymentMethod ||
      !customerName ||
      !customerEmail ||
      !customerCpfCnpj ||
      !customerPhone
    ) {
      return res.status(400).json({
        error:
          "Preencha todos os dados do comprador e do pedido."
      });
    }

    const cleanPlayerId =
      String(playerId).trim();

    if (!/^\d{5,15}$/.test(cleanPlayerId)) {
      return res.status(400).json({
        error:
          "Digite um ID de jogador válido."
      });
    }

    const product =
      products.find(
        p => p.id === productId
      );

    if (!product) {
      return res.status(400).json({
        error:
          "Produto inválido."
      });
    }

    if (
      !["pix", "card"].includes(
        paymentMethod
      )
    ) {
      return res.status(400).json({
        error:
          "Forma de pagamento inválida."
      });
    }

    const cleanName =
      String(customerName).trim();

    const cleanEmail =
      String(customerEmail)
        .trim()
        .toLowerCase();

    const cleanCpfCnpj =
      String(customerCpfCnpj)
        .replace(/\D/g, "");

    const cleanPhone =
      String(customerPhone)
        .replace(/\D/g, "");

    if (cleanName.length < 3) {
      return res.status(400).json({
        error:
          "Digite o nome completo."
      });
    }

    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        cleanEmail
      )
    ) {
      return res.status(400).json({
        error:
          "Digite um e-mail válido."
      });
    }

    if (
      ![11, 14].includes(
        cleanCpfCnpj.length
      )
    ) {
      return res.status(400).json({
        error:
          "CPF/CNPJ inválido."
      });
    }

    if (
      cleanPhone.length < 10 ||
      cleanPhone.length > 11
    ) {
      return res.status(400).json({
        error:
          "Celular inválido."
      });
    }

    if (!asaasConfigured()) {
      return res.status(500).json({
        error:
          "O pagamento ainda não está configurado no servidor."
      });
    }

    /* ---------- pedido ---------- */

    const orderId =
      "VZ-" +
      Date.now()
        .toString(36)
        .toUpperCase();

    const billingTypes =
      paymentMethod === "pix"
        ? ["PIX"]
        : ["CREDIT_CARD"];

    const baseUrl =
      getBaseUrl(req);

    /*
      Esta referência será enviada ao Asaas.
      Ela permite identificar a qual pedido pertence
      o pagamento recebido no Webhook.
    */
    const externalReference =
      `${orderId}|PLAYER:${cleanPlayerId}|PRODUCT:${product.id}`;

    /*
      Criamos o pedido ANTES do checkout.
    */
    const order = {
      id: orderId,
      playerId: cleanPlayerId,

      productId: product.id,
      diamonds: product.diamonds,
      price: product.price,

      paymentMethod,

      customer: {
        name: cleanName,
        email: cleanEmail,
        cpfCnpj: cleanCpfCnpj,
        phone: cleanPhone
      },

      externalReference,

      status: "waiting_payment",

      checkoutId: null,
      paymentId: null,

      createdAt:
        new Date().toISOString(),

      updatedAt:
        new Date().toISOString()
    };

    orders.set(
      orderId,
      order
    );

    /* ---------- checkout Asaas ---------- */

    const checkout =
      await asaasRequest(
        "/checkouts",
        {
          method: "POST",

          body: JSON.stringify({
            billingTypes,

            chargeTypes: [
              "DETACHED"
            ],

            minutesToExpire: 60,

            externalReference,

            callback: {
              successUrl:
                `${baseUrl}/pagamento/sucesso?pedido=${encodeURIComponent(orderId)}`,

              cancelUrl:
                `${baseUrl}/pagamento/cancelado?pedido=${encodeURIComponent(orderId)}`,

              expiredUrl:
                `${baseUrl}/pagamento/expirado?pedido=${encodeURIComponent(orderId)}`
            },

            customerData: {
              name: cleanName,
              cpfCnpj: cleanCpfCnpj,
              email: cleanEmail,
              phone: cleanPhone
            },

            items: [
              {
                externalReference:
                  product.id,

                name:
                  `${product.diamonds.toLocaleString("pt-BR")} Diamantes`,

                description:
                  `Pedido VIBEZ DIAMONDS - ID ${cleanPlayerId}`,

                quantity: 1,

                value:
                  product.price
              }
            ]
          })
        }
      );

    order.checkoutId =
      checkout.id || null;

    order.updatedAt =
      new Date().toISOString();

    orders.set(
      orderId,
      order
    );

    console.log(
      "Checkout Asaas criado:",
      checkout.id
    );

    console.log(
      "Pedido:",
      orderId
    );

    res.json({
      ok: true,

      order: {
        id: order.id,
        playerId: order.playerId,
        productId: order.productId,
        diamonds: order.diamonds,
        price: order.price,
        paymentMethod:
          order.paymentMethod,
        status: order.status
      },

      checkout: {
        id: checkout.id,
        link: checkout.link,
        status: checkout.status
      }
    });

  } catch (err) {
    console.error(
      "Erro ao criar pedido:",
      err
    );

    res.status(500).json({
      error:
        err.message ||
        "Não foi possível criar o pagamento."
    });
  }
});

/* =========================
   WEBHOOK ASAAS
========================= */

app.post(
  "/webhook/asaas",
  async (req, res) => {
    try {
      /*
        O Asaas envia o authToken configurado no Webhook
        através do header "asaas-access-token".
      */
      const receivedToken =
        req.get(
          "asaas-access-token"
        );

      const expectedToken =
        process.env.ASAAS_WEBHOOK_TOKEN;

      if (
        !expectedToken ||
        !receivedToken ||
        receivedToken !==
          expectedToken
      ) {
        console.warn(
          "Webhook Asaas recusado: token inválido."
        );

        return res.status(401).json({
          error:
            "Webhook não autorizado."
        });
      }

      const event = req.body || {};

      const eventId =
        String(event.id || "").trim();

      const eventName =
        String(event.event || "").trim();

      /*
        Evita processar o mesmo evento mais de uma vez.
      */
      if (
        eventId &&
        processedWebhookEvents.has(
          eventId
        )
      ) {
        return res.status(200).json({
          received: true,
          duplicate: true
        });
      }

      if (eventId) {
        processedWebhookEvents.add(
          eventId
        );
      }

      console.log(
        "Webhook Asaas:",
        eventName,
        eventId
      );

      const payment =
        event.payment || {};

      /*
        Para eventos de pagamento, o Asaas envia
        payment.externalReference.
      */
      const externalReference =
        payment.externalReference ||
        event.externalReference ||
        "";

      /*
        Nossa referência tem este formato:

        VZ-XXXXX|PLAYER:123456|PRODUCT:d100

        Pegamos somente o ID interno.
      */
      const orderId =
        String(
          externalReference
        ).split("|")[0];

      const order =
        orders.get(orderId);

      /*
        Eventos financeiros considerados pagos.
        PAYMENT_CONFIRMED:
        pagamento confirmado.

        PAYMENT_RECEIVED:
        pagamento recebido.
      */
      if (
        eventName ===
          "PAYMENT_CONFIRMED" ||
        eventName ===
          "PAYMENT_RECEIVED"
      ) {
        if (order) {
          order.status = "paid";

          order.paymentId =
            payment.id || null;

          order.updatedAt =
            new Date().toISOString();

          orders.set(
            orderId,
            order
          );

          console.log(
            "================================"
          );

          console.log(
            "PAGAMENTO CONFIRMADO!"
          );

          console.log(
            "Pedido:",
            order.id
          );

          console.log(
            "Pagamento:",
            order.paymentId
          );

          console.log(
            "Jogador:",
            order.playerId
          );

          console.log(
            "Diamantes:",
            order.diamonds
          );

          console.log(
            "Valor:",
            order.price
          );

          console.log(
            "================================"
          );

          /*
            IMPORTANTE:

            A partir daqui podemos colocar,
            em uma próxima etapa, a chamada do
            fornecedor autorizado para entregar
            os diamantes.

            NÃO coloque essa entrega aqui até
            termos a integração correta do fornecedor.
          */
        } else {
          console.warn(
            "Pagamento recebido, mas pedido não está em memória:",
            orderId
          );
        }
      }

      /*
        Pagamento recusado/cancelado.
      */
      if (
        eventName ===
          "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED" ||
        eventName ===
          "PAYMENT_OVERDUE" ||
        eventName ===
          "PAYMENT_DELETED"
      ) {
        if (order) {
          order.status =
            "payment_failed";

          order.paymentId =
            payment.id || null;

          order.updatedAt =
            new Date().toISOString();

          orders.set(
            orderId,
            order
          );
        }
      }

      /*
        Reembolso.
      */
      if (
        eventName ===
          "PAYMENT_REFUNDED"
      ) {
        if (order) {
          order.status =
            "refunded";

          order.paymentId =
            payment.id || null;

          order.updatedAt =
            new Date().toISOString();

          orders.set(
            orderId,
            order
          );
        }
      }

      /*
        Sempre responder 200 rapidamente.
      */
      return res.status(200).json({
        received: true
      });

    } catch (err) {
      console.error(
        "Erro no Webhook Asaas:",
        err
      );

      return res.status(500).json({
        error:
          "Erro ao processar Webhook."
      });
    }
  }
);

/* =========================
   PÁGINA DE SUCESSO
========================= */

app.get(
  "/pagamento/sucesso",
  (req, res) => {
    const pedido =
      String(
        req.query.pedido || ""
      ).replace(
        /[^a-zA-Z0-9_-]/g,
        ""
      );

    res.send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport"
      content="width=device-width,initial-scale=1">

<title>VIBEZ DIAMONDS - Pagamento</title>

<style>
*{
  box-sizing:border-box;
}

body{
  margin:0;
  min-height:100vh;
  display:flex;
  align-items:center;
  justify-content:center;
  background:
    radial-gradient(
      circle at top,
      #2b1454,
      #08070d 65%
    );
  color:white;
  font-family:Arial,sans-serif;
}

.box{
  width:min(92%,520px);
  padding:35px;
  text-align:center;
  border-radius:24px;
  background:#151221;
  border:1px solid #2b2440;
  box-shadow:0 20px 70px #0008;
}

.icon{
  font-size:60px;
}

h1{
  color:#a78bfa;
}

p{
  color:#aaa3b8;
  line-height:1.6;
}

.order{
  color:#c4b5fd;
}

.status{
  margin-top:20px;
  padding:15px;
  border-radius:14px;
  background:#0e0b16;
  border:1px solid #2b2440;
  color:#ddd;
}

.status.paid{
  border-color:#22c55e;
  color:#86efac;
}

a{
  display:inline-block;
  margin-top:20px;
  padding:14px 20px;
  border-radius:12px;
  background:#8b5cf6;
  color:white;
  text-decoration:none;
  font-weight:bold;
}
</style>
</head>

<body>

<div class="box">

  <div class="icon">💳</div>

  <h1>Checkout concluído</h1>

  <p>
    Estamos verificando a confirmação financeira
    do seu pagamento.
  </p>

  <p class="order">
    Pedido: ${pedido}
  </p>

  <div
    id="status"
    class="status">
    ⏳ Aguardando confirmação do Asaas...
  </div>

  <a href="/">
    Voltar para a VIBEZ DIAMONDS
  </a>

</div>

<script>

const orderId =
  ${JSON.stringify(pedido)};

const statusEl =
  document.getElementById("status");

async function checkStatus(){

  if(!orderId){
    statusEl.textContent =
      "Pedido inválido.";
    return;
  }

  try{

    const response =
      await fetch(
        "/api/orders/" +
        encodeURIComponent(orderId)
      );

    const data =
      await response.json();

    if(!response.ok){
      statusEl.textContent =
        data.error ||
        "Pedido não encontrado.";
      return;
    }

    const status =
      data.order.status;

    if(status === "paid"){

      statusEl.className =
        "status paid";

      statusEl.textContent =
        "✅ Pagamento confirmado pelo Asaas!";

      return;
    }

    if(status === "payment_failed"){

      statusEl.className =
        "status";

      statusEl.textContent =
        "❌ O pagamento não foi aprovado.";

      return;
    }

    if(status === "refunded"){

      statusEl.className =
        "status";

      statusEl.textContent =
        "⚠️ Este pagamento foi estornado.";

      return;
    }

    statusEl.textContent =
      "⏳ Aguardando confirmação do Asaas...";

  }catch(error){

    console.error(error);

    statusEl.textContent =
      "Verificando pagamento...";
  }
}

checkStatus();

setInterval(
  checkStatus,
  5000
);

</script>

</body>
</html>
`);
  }
);

/* =========================
   CANCELADO
========================= */

app.get(
  "/pagamento/cancelado",
  (req, res) => {

    res.send(`
<!DOCTYPE html>
<html lang="pt-BR">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width,initial-scale=1">

<title>Pagamento cancelado</title>

<style>

body{
  margin:0;
  min-height:100vh;
  display:flex;
  align-items:center;
  justify-content:center;
  background:#08070d;
  color:white;
  font-family:Arial,sans-serif;
}

.box{
  width:min(90%,500px);
  padding:35px;
  text-align:center;
  border-radius:24px;
  background:#151221;
  border:1px solid #2b2440;
}

.icon{
  font-size:60px;
}

h1{
  color:#f59e0b;
}

p{
  color:#aaa3b8;
  line-height:1.6;
}

a{
  display:inline-block;
  margin-top:20px;
  padding:14px 20px;
  border-radius:12px;
  background:#8b5cf6;
  color:white;
  text-decoration:none;
  font-weight:bold;
}

</style>

</head>

<body>

<div class="box">

<div class="icon">⚠️</div>

<h1>Pagamento cancelado</h1>

<p>
O pagamento não foi concluído.
</p>

<a href="/">
Tentar novamente
</a>

</div>

</body>
</html>
`);
  }
);

/* =========================
   EXPIRADO
========================= */

app.get(
  "/pagamento/expirado",
  (req, res) => {

    res.send(`
<!DOCTYPE html>
<html lang="pt-BR">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width,initial-scale=1">

<title>Pagamento expirado</title>

<style>

body{
  margin:0;
  min-height:100vh;
  display:flex;
  align-items:center;
  justify-content:center;
  background:#08070d;
  color:white;
  font-family:Arial,sans-serif;
}

.box{
  width:min(90%,500px);
  padding:35px;
  text-align:center;
  border-radius:24px;
  background:#151221;
  border:1px solid #2b2440;
}

.icon{
  font-size:60px;
}

h1{
  color:#ef4444;
}

p{
  color:#aaa3b8;
  line-height:1.6;
}

a{
  display:inline-block;
  margin-top:20px;
  padding:14px 20px;
  border-radius:12px;
  background:#8b5cf6;
  color:white;
  text-decoration:none;
  font-weight:bold;
}

</style>

</head>

<body>

<div class="box">

<div class="icon">⏰</div>

<h1>Checkout expirado</h1>

<p>
O prazo do
