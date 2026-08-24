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

const products = [
  { id: "d100", diamonds: 100, price: 4.99 },
  { id: "d310", diamonds: 310, price: 12.99 },
  { id: "d520", diamonds: 520, price: 19.99 },
  { id: "d1060", diamonds: 1060, price: 39.99 },
  { id: "d2180", diamonds: 2180, price: 79.99 },
  { id: "d5600", diamonds: 5600, price: 199.99 }
];

function asaasConfigured() {
  return Boolean(process.env.ASAAS_API_KEY);
}

function getBaseUrl(req) {
  return (
    process.env.PUBLIC_URL ||
    `${req.protocol}://${req.get("host")}`
  ).replace(/\/$/, "");
}

async function asaasRequest(endpoint, options = {}) {
  if (!process.env.ASAAS_API_KEY) {
    throw new Error("ASAAS_API_KEY não configurada no Render.");
  }

  const response = await fetch(`${ASAAS_API_URL}${endpoint}`, {
    ...options,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      access_token: process.env.ASAAS_API_KEY,
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    console.error("Erro Asaas:", response.status, data);

    const message =
      data?.errors?.map?.(e => e.description).join(" ") ||
      data?.message ||
      "Erro retornado pelo Asaas.";

    throw new Error(message);
  }

  return data;
}

/* =========================
   CONFIGURAÇÃO
========================= */

app.get("/api/config", (_, res) => {
  res.json({
    storeName: process.env.STORE_NAME || "VIBEZ DIAMONDS",
    asaasConfigured: asaasConfigured(),
    supplierConfigured: Boolean(
      process.env.SUPPLIER_API_URL &&
      process.env.SUPPLIER_API_KEY
    )
  });
});

/* =========================
   PRODUTOS
========================= */

app.get("/api/products", (_, res) => {
  res.json({ products });
});

/* =========================
   CRIAR PEDIDO + CHECKOUT ASAAS
========================= */

app.post("/api/orders", async (req, res) => {
  try {
    const {
      playerId,
      productId,
      paymentMethod
    } = req.body;

    if (!playerId || !productId || !paymentMethod) {
      return res.status(400).json({
        error: "Preencha todos os dados."
      });
    }

    const cleanPlayerId = String(playerId).trim();

    if (!/^\d{5,15}$/.test(cleanPlayerId)) {
      return res.status(400).json({
        error: "Digite um ID de jogador válido."
      });
    }

    const product = products.find(
      p => p.id === productId
    );

    if (!product) {
      return res.status(400).json({
        error: "Produto inválido."
      });
    }

    if (!["pix", "card"].includes(paymentMethod)) {
      return res.status(400).json({
        error: "Forma de pagamento inválida."
      });
    }

    if (!asaasConfigured()) {
      return res.status(500).json({
        error:
          "O pagamento ainda não está configurado no servidor."
      });
    }

    /*
      ID interno do pedido.

      O ID do jogador é colocado apenas como referência
      do pedido. Não é enviado como dado financeiro.
    */
    const orderId =
      "VZ-" +
      Date.now().toString(36).toUpperCase();

    const billingTypes =
      paymentMethod === "pix"
        ? ["PIX"]
        : ["CREDIT_CARD"];

    const baseUrl = getBaseUrl(req);

    const checkout = await asaasRequest(
      "/checkouts",
      {
        method: "POST",
        body: JSON.stringify({
          billingTypes,
          chargeTypes: ["DETACHED"],
          minutesToExpire: 60,

          externalReference:
            `${orderId}|PLAYER:${cleanPlayerId}|PRODUCT:${product.id}`,

          callback: {
            successUrl:
              `${baseUrl}/pagamento/sucesso?pedido=${encodeURIComponent(orderId)}`,

            cancelUrl:
              `${baseUrl}/pagamento/cancelado?pedido=${encodeURIComponent(orderId)}`,

            expiredUrl:
              `${baseUrl}/pagamento/expirado?pedido=${encodeURIComponent(orderId)}`
          },

          items: [
            {
              externalReference: product.id,
              name:
                `${product.diamonds.toLocaleString("pt-BR")} Diamantes`,
              description:
                `Pedido VIBEZ DIAMONDS - ID ${cleanPlayerId}`,
              quantity: 1,
              value: product.price
            }
          ]
        })
      }
    );

    console.log(
      "Checkout Asaas criado:",
      checkout.id,
      "Pedido:",
      orderId
    );

    res.json({
      ok: true,

      order: {
        id: orderId,
        playerId: cleanPlayerId,
        productId: product.id,
        diamonds: product.diamonds,
        price: product.price,
        paymentMethod,
        status: "waiting_payment"
      },

      checkout: {
        id: checkout.id,
        link: checkout.link,
        status: checkout.status
      }
    });

  } catch (err) {
    console.error("Erro ao criar pedido:", err);

    res.status(500).json({
      error:
        err.message ||
        "Não foi possível criar o pagamento."
    });
  }
});

/* =========================
   PÁGINAS DE RETORNO
========================= */

app.get("/pagamento/sucesso", (req, res) => {
  const pedido = req.query.pedido || "";

  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport"
            content="width=device-width,initial-scale=1">
      <title>Pagamento realizado</title>

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
          color:#22c55e;
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

        .order{
          color:#c4b5fd;
        }
      </style>
    </head>

    <body>
      <div class="box">
        <div class="icon">✅</div>

        <h1>Pagamento recebido</h1>

        <p>
          Seu pagamento foi encaminhado para processamento.
        </p>

        <p class="order">
          Pedido: ${String(pedido)
            .replace(/[<>]/g, "")}
        </p>

        <p>
          A entrega dos diamantes deverá ocorrer somente
          após a confirmação do pagamento e da integração
          autorizada com o fornecedor.
        </p>

        <a href="/">
          Voltar para a VIBEZ DIAMONDS
        </a>
      </div>
    </body>
    </html>
  `);
});

app.get("/pagamento/cancelado", (req, res) => {
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
});

app.get("/pagamento/expirado", (req, res) => {
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
          O prazo do pagamento terminou.
        </p>

        <a href="/">
          Criar novo pedido
        </a>
      </div>
    </body>
    </html>
  `);
});

/* =========================
   FRONTEND
========================= */

app.get("*", (_, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

app.listen(PORT, () => {
  console.log(
    `VIBEZ DIAMONDS rodando na porta ${PORT}`
  );

  console.log(
    `Asaas configurado: ${asaasConfigured()}`
  );

  console.log(
    `URL Asaas: ${ASAAS_API_URL}`
  );
});
