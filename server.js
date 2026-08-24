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

/*
  IMPORTANTE:
  Seu index.html está na raiz do GitHub.
  Por isso usamos __dirname aqui.
*/
app.use(express.static(__dirname));

/* =========================
   ASAAS
========================= */

const ASAAS_API_URL =
  process.env.ASAAS_API_URL || "https://api.asaas.com/v3";

/* =========================
   PRODUTOS
========================= */

const products = [
  {
    id: "d100",
    diamonds: 100,
    price: 5.00
  },
  {
    id: "d310",
    diamonds: 310,
    price: 12.99
  },
  {
    id: "d520",
    diamonds: 520,
    price: 19.99
  },
  {
    id: "d1060",
    diamonds: 1060,
    price: 39.99
  },
  {
    id: "d2180",
    diamonds: 2180,
    price: 79.99
  },
  {
    id: "d5600",
    diamonds: 5600,
    price: 199.99
  }
];

/* =========================
   FUNÇÕES
========================= */

function asaasConfigured() {
  return Boolean(process.env.ASAAS_API_KEY);
}

function getBaseUrl(req) {
  const url =
    process.env.PUBLIC_URL ||
    `${req.protocol}://${req.get("host")}`;

  return url.replace(/\/$/, "");
}

function getAsaasCheckoutLink(checkout) {
  if (checkout && checkout.link) {
    return checkout.link;
  }

  if (!checkout || !checkout.id) {
    return null;
  }

  const isSandbox =
    ASAAS_API_URL.includes("sandbox");

  const domain = isSandbox
    ? "https://sandbox.asaas.com"
    : "https://asaas.com";

  return `${domain}/checkoutSession/show?id=${encodeURIComponent(
    checkout.id
  )}`;
}

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
      "Erro retornado pelo Asaas:",
      response.status,
      data
    );

    const message =
      data?.errors
        ?.map?.((error) => error.description)
        .join(" ") ||
      data?.message ||
      "Erro retornado pelo Asaas.";

    throw new Error(message);
  }

  return data;
}

/* =========================
   CONFIGURAÇÃO
========================= */

app.get("/api/config", (req, res) => {
  res.json({
    storeName:
      process.env.STORE_NAME ||
      "VIBEZ DIAMONDS",

    asaasConfigured:
      asaasConfigured(),

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

app.get("/api/products", (req, res) => {
  res.json({
    products
  });
});

/* =========================
   CRIAR CHECKOUT
========================= */

app.post("/api/orders", async (req, res) => {
  try {
    const {
      playerId,
      productId,
      paymentMethod
    } = req.body;

    /* ---------- validação básica ---------- */

    if (
      !playerId ||
      !productId ||
      !paymentMethod
    ) {
      return res.status(400).json({
        error: "Preencha todos os dados."
      });
    }

    /* ---------- ID do jogador ---------- */

    const cleanPlayerId =
      String(playerId).trim();

    if (!/^\d{5,15}$/.test(cleanPlayerId)) {
      return res.status(400).json({
        error:
          "Digite um ID de jogador válido."
      });
    }

    /* ---------- produto ---------- */

    const product = products.find(
      (item) =>
        item.id === productId
    );

    if (!product) {
      return res.status(400).json({
        error: "Produto inválido."
      });
    }

    /* ---------- pagamento ---------- */

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

    /* ---------- Asaas ---------- */

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

    /* ---------- método Asaas ---------- */

    const billingTypes =
      paymentMethod === "pix"
        ? ["PIX"]
        : ["CREDIT_CARD"];

    /* ---------- URL do site ---------- */

    const baseUrl =
      getBaseUrl(req);

    /* ---------- criar Checkout ---------- */

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

            externalReference:
              `${orderId}|PLAYER:${cleanPlayerId}|PRODUCT:${product.id}`,

            callback: {
              successUrl:
                `${baseUrl}/pagamento/sucesso?pedido=${encodeURIComponent(
                  orderId
                )}`,

              cancelUrl:
                `${baseUrl}/pagamento/cancelado?pedido=${encodeURIComponent(
                  orderId
                )}`,

              expiredUrl:
                `${baseUrl}/pagamento/expirado?pedido=${encodeURIComponent(
                  orderId
                )}`
            },

            items: [
              {
                externalReference:
                  product.id,

                name:
                  `${product.diamonds.toLocaleString(
                    "pt-BR"
                  )} Diamantes`,

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

    /* ---------- link do Checkout ---------- */

    const checkoutLink =
      getAsaasCheckoutLink(
        checkout
      );

    if (!checkoutLink) {
      throw new Error(
        "O Asaas criou o Checkout, mas não retornou o link."
      );
    }

    console.log(
      "================================"
    );

    console.log(
      "CHECKOUT ASAAS CRIADO"
    );

    console.log(
      "Pedido:",
      orderId
    );

    console.log(
      "Checkout:",
      checkout.id
    );

    console.log(
      "Status:",
      checkout.status
    );

    console.log(
      "================================"
    );

    /* ---------- resposta ---------- */

    return res.json({
      ok: true,

      order: {
        id: orderId,

        playerId:
          cleanPlayerId,

        productId:
          product.id,

        diamonds:
          product.diamonds,

        price:
          product.price,

        paymentMethod,

        status:
          "waiting_payment"
      },

      checkout: {
        id:
          checkout.id,

        link:
          checkoutLink,

        status:
          checkout.status
      }
    });

  } catch (error) {
    console.error(
      "================================"
    );

    console.error(
      "ERRO AO CRIAR PEDIDO"
    );

    console.error(
      error
    );

    console.error(
      "================================"
    );

    return res.status(500).json({
      error:
        error.message ||
        "Não foi possível criar o pagamento."
    });
  }
});

/* =========================
   PAGAMENTO - SUCESSO
========================= */

app.get(
  "/pagamento/sucesso",
  (req, res) => {
    const pedido =
      String(
        req.query.pedido || ""
      ).replace(
        /[<>]/g,
        ""
      );

    res.send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>Pagamento recebido</title>

<style>
body{
  margin:0;
  min-height:100vh;
  display:flex;
  align-items:center;
  justify-content:center;
  background:#08070d;
  color:#fff;
  font-family:Arial,sans-serif;
}

.box{
  width:min(90%,500px);
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
  color:#22c55e;
}

p{
  color:#aaa3b8;
  line-height:1.6;
}

.order{
  color:#c4b5fd;
}

a{
  display:inline-block;
  margin-top:20px;
  padding:14px 20px;
  border-radius:12px;
  background:#8b5cf6;
  color:#fff;
  text-decoration:none;
  font-weight:bold;
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
Pedido: ${pedido}
</p>

<p>
A entrega dos diamantes somente deverá ocorrer
depois da confirmação financeira e da integração
autorizada com o fornecedor.
</p>

<a href="/">
Voltar para VIBEZ DIAMONDS
</a>

</div>

</body>
</html>
`);
  }
);

/* =========================
   PAGAMENTO - CANCELADO
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
  color:#fff;
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
  color:#fff;
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
   PAGAMENTO - EXPIRADO
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

<title>Checkout expirado</title>

<style>

body{
  margin:0;
  min-height:100vh;
  display:flex;
  align-items:center;
  justify-content:center;
  background:#08070d;
  color:#fff;
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
  color:#fff;
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
O prazo para realizar o pagamento terminou.
</p>

<a href="/">
Criar novo pedido
</a>

</div>

</body>

</html>
`);
  }
);

/* =========================
   PÁGINA PRINCIPAL
========================= */

/*
  NÃO usamos app.get("*") aqui.
  Isso evita problemas de roteamento
  com versões recentes do Express.
*/

app.use(
  (req, res, next) => {

    if (
      req.method !== "GET" ||
      req.path.startsWith("/api/")
    ) {
      return next();
    }

    res.sendFile(
      path.join(
        __dirname,
        "index.html"
      )
    );
  }
);

/* =========================
   ERRO 404
========================= */

app.use(
  (req, res) => {

    res.status(404).json({
      error: "Página não encontrada."
    });
  }
);

/* =========================
   INICIAR SERVIDOR
========================= */

app.listen(
  PORT,
  () => {

    console.log(
      "================================"
    );

    console.log(
      `VIBEZ DIAMONDS rodando na porta ${PORT}`
    );

    console.log(
      `Asaas configurado: ${asaasConfigured()}`
    );

    console.log(
      `URL Asaas: ${ASAAS_API_URL}`
    );

    console.log(
      "================================"
    );
  }
);
