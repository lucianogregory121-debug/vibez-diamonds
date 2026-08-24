require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(express.json({ limit: "1mb" }));

// Serve os arquivos do projeto
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, "public")));

const products = [
  { id: "d100", diamonds: 100, price: 4.99 },
  { id: "d310", diamonds: 310, price: 12.99 },
  { id: "d520", diamonds: 520, price: 19.99 },
  { id: "d1060", diamonds: 1060, price: 39.99 },
  { id: "d2180", diamonds: 2180, price: 79.99 },
  { id: "d5600", diamonds: 5600, price: 199.99 }
];

/*
=========================================================
CONFIGURAÇÃO ASAAS
=========================================================
No Render:

ASAAS_API_KEY = sua chave do Asaas

Opcional:
ASAAS_API_URL = https://api.asaas.com/v3

Para produção usamos api.asaas.com.
Para Sandbox:
https://api-sandbox.asaas.com/v3
*/

const ASAAS_API_KEY = process.env.ASAAS_API_KEY;

const ASAAS_API_URL =
  process.env.ASAAS_API_URL || "https://api.asaas.com/v3";

/*
=========================================================
FUNÇÃO PARA CHAMAR O ASAAS
=========================================================
*/

async function asaasRequest(endpoint, options = {}) {
  if (!ASAAS_API_KEY) {
    throw new Error("ASAAS_API_KEY não configurada no Render.");
  }

  const response = await fetch(`${ASAAS_API_URL}${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "VIBEZ-DIAMONDS/1.0 Node.js",
      "access_token": ASAAS_API_KEY,
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    console.error("Erro retornado pelo Asaas:", {
      status: response.status,
      data
    });

    const message =
      data?.errors?.map?.(e => e.description).join("; ") ||
      data?.message ||
      "Erro na API do Asaas.";

    throw new Error(message);
  }

  return data;
}

/*
=========================================================
CONFIG
=========================================================
*/

app.get("/api/config", (_, res) => {
  res.json({
    storeName: process.env.STORE_NAME || "VIBEZ DIAMONDS",

    supplierConfigured: Boolean(
      process.env.SUPPLIER_API_URL &&
      process.env.SUPPLIER_API_KEY
    ),

    asaasConfigured: Boolean(ASAAS_API_KEY)
  });
});

/*
=========================================================
PRODUTOS
=========================================================
*/

app.get("/api/products", (_, res) => {
  res.json({
    products
  });
});

/*
=========================================================
CRIAR CLIENTE NO ASAAS
=========================================================
*/

async function createAsaasCustomer(playerId) {
  const customer = await asaasRequest("/customers", {
    method: "POST",

    body: JSON.stringify({
      name: `Cliente VIBEZ - ${playerId}`,
      externalReference: `VZ-PLAYER-${playerId}`,
      notificationDisabled: true
    })
  });

  return customer;
}

/*
=========================================================
CRIAR PEDIDO
=========================================================
*/

app.post("/api/orders", async (req, res) => {
  try {
    const {
      playerId,
      productId,
      paymentMethod
    } = req.body;

    /*
    -----------------------------------------------
    VALIDAÇÃO
    -----------------------------------------------
    */

    if (!playerId || !productId || !paymentMethod) {
      return res.status(400).json({
        error: "Preencha todos os dados."
      });
    }

    const cleanPlayerId = String(playerId).trim();

    if (cleanPlayerId.length < 3 || cleanPlayerId.length > 30) {
      return res.status(400).json({
        error: "ID do jogador inválido."
      });
    }

    /*
    -----------------------------------------------
    PRODUTO
    -----------------------------------------------
    */

    const product = products.find(
      p => p.id === productId
    );

    if (!product) {
      return res.status(400).json({
        error: "Produto inválido."
      });
    }

    /*
    -----------------------------------------------
    FORMA DE PAGAMENTO
    -----------------------------------------------
    */

    let billingType;

    if (
      paymentMethod === "pix" ||
      paymentMethod === "PIX"
    ) {
      billingType = "PIX";
    } else if (
      paymentMethod === "card" ||
      paymentMethod === "credit_card" ||
      paymentMethod === "CREDIT_CARD"
    ) {
      billingType = "CREDIT_CARD";
    } else {
      return res.status(400).json({
        error: "Forma de pagamento inválida."
      });
    }

    /*
    -----------------------------------------------
    ID DO PEDIDO
    -----------------------------------------------
    */

    const orderId =
      "VZ-" +
      Date.now()
        .toString(36)
        .toUpperCase();

    console.log("=================================");
    console.log("NOVO PEDIDO");
    console.log("Pedido:", orderId);
    console.log("Jogador:", cleanPlayerId);
    console.log("Produto:", product.diamonds, "diamantes");
    console.log("Valor:", product.price);
    console.log("Pagamento:", billingType);
    console.log("=================================");

    /*
    -----------------------------------------------
    CRIA CLIENTE NO ASAAS
    -----------------------------------------------
    */

    const customer =
      await createAsaasCustomer(cleanPlayerId);

    console.log(
      "Cliente Asaas criado:",
      customer.id
    );

    /*
    -----------------------------------------------
    DATA DE VENCIMENTO
    -----------------------------------------------
    */

    const tomorrow = new Date();

    tomorrow.setDate(
      tomorrow.getDate() + 1
    );

    const dueDate =
      tomorrow.toISOString().split("T")[0];

    /*
    -----------------------------------------------
    CRIA COBRANÇA ASAAS
    -----------------------------------------------
    */

    const payment =
      await asaasRequest("/payments", {
        method: "POST",

        body: JSON.stringify({
          customer: customer.id,

          billingType,

          value: Number(
            product.price.toFixed(2)
          ),

          dueDate,

          description:
            `${product.diamonds} diamantes - VIBEZ DIAMONDS`,

          externalReference: orderId
        })
      });

    console.log(
      "Cobrança Asaas criada:",
      payment.id
    );

    /*
    -----------------------------------------------
    RESULTADO BASE
    -----------------------------------------------
    */

    const result = {
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

      asaas: {
        customerId: customer.id,

        paymentId: payment.id,

        status: payment.status,

        invoiceUrl:
          payment.invoiceUrl || null,

        bankSlipUrl:
          payment.bankSlipUrl || null
      }
    };

    /*
    -----------------------------------------------
    PIX
    -----------------------------------------------
    */

    if (billingType === "PIX") {
      try {
        const pix =
          await asaasRequest(
            `/payments/${payment.id}/pixQrCode`,
            {
              method: "GET"
            }
          );

        result.asaas.pix = {
          encodedImage:
            pix.encodedImage || null,

          payload:
            pix.payload || null,

          expirationDate:
            pix.expirationDate || null
        };

        console.log(
          "QR Code Pix gerado."
        );

      } catch (pixError) {
        console.error(
          "Cobrança criada, mas não foi possível obter o Pix:",
          pixError.message
        );

        result.asaas.pixError =
          "Não foi possível gerar o QR Code Pix.";
      }
    }

    /*
    -----------------------------------------------
    RESPOSTA
    -----------------------------------------------
    */

    return res.json(result);

  } catch (err) {
    console.error(
      "Erro ao criar pedido:",
      err
    );

    return res.status(500).json({
      ok: false,
      error:
        err.message ||
        "Erro ao criar cobrança no Asaas."
    });
  }
});

/*
=========================================================
CONSULTAR PAGAMENTO
=========================================================
*/

app.get(
  "/api/payments/:paymentId",
  async (req, res) => {
    try {
      const payment =
        await asaasRequest(
          `/payments/${encodeURIComponent(
            req.params.paymentId
          )}`,
          {
            method: "GET"
          }
        );

      res.json({
        ok: true,
        payment
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        ok: false,
        error:
          err.message ||
          "Erro ao consultar pagamento."
      });
    }
  }
);

/*
=========================================================
PÁGINA PRINCIPAL
=========================================================
*/

app.get("*", (_, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

/*
=========================================================
SERVIDOR
=========================================================
*/

app.listen(PORT, () => {
  console.log(
    `VIBEZ DIAMONDS rodando na porta ${PORT}`
  );

  console.log(
    "Asaas configurado:",
    Boolean(ASAAS_API_KEY)
  );

  console.log(
    "URL Asaas:",
    ASAAS_API_URL
  );
});
