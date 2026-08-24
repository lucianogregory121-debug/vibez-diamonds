const express = require("express");
const helmet = require("helmet");
const crypto = require("crypto");
const path = require("path");

// dotenv é opcional.
// No Render, as variáveis ficam disponíveis diretamente em process.env.
try {
  require("dotenv").config();
} catch (_) {}

const app = express();

const PORT = process.env.PORT || 3000;

// ======================================================
// CONFIGURAÇÕES
// ======================================================

const STORE_NAME =
  process.env.STORE_NAME || "VIBEZ DIAMONDS";

// FreeFire Shop
const FREEFIRE_API_URL = (
  process.env.FREEFIRE_API_URL ||
  "https://freefireshop.com.br"
).replace(/\/$/, "");

const FREEFIRE_USER_ID =
  process.env.FREEFIRE_USER_ID || "";

const FREEFIRE_API_KEY =
  process.env.FREEFIRE_API_KEY || "";

// Asaas
const ASAAS_API_URL = (
  process.env.ASAAS_API_URL ||
  "https://api.asaas.com/v3"
).replace(/\/$/, "");

const ASAAS_API_KEY =
  process.env.ASAAS_API_KEY || "";

// URL pública do Render
const PUBLIC_URL = (
  process.env.PUBLIC_URL || ""
).replace(/\/$/, "");

// Token usado para proteger o webhook do Asaas
const WEBHOOK_AUTH_TOKEN =
  process.env.ASAAS_WEBHOOK_AUTH_TOKEN || "";

// Chave interna para criptografar os dados do pedido
const ORDER_SECRET =
  process.env.ORDER_SECRET || "";


// ======================================================
// PRODUTOS
// ======================================================

const products = {

  d200: {
    id: "d200",
    type: "diamonds",
    name: "200 Diamantes",
    amount: "200",
    price: 10.90,
    requires: "accessToken"
  },

  d620: {
    id: "d620",
    type: "diamonds",
    name: "620 Diamantes",
    amount: "620",
    price: 24.90,
    requires: "accessToken"
  },

  d1040: {
    id: "d1040",
    type: "diamonds",
    name: "1.040 Diamantes",
    amount: "1040",
    price: 34.90,
    requires: "accessToken"
  },

  d2120: {
    id: "d2120",
    type: "diamonds",
    name: "2.120 Diamantes",
    amount: "2120",
    price: 64.90,
    requires: "accessToken"
  },

  d4360: {
    id: "d4360",
    type: "diamonds",
    name: "4.360 Diamantes",
    amount: "4360",
    price: 119.90,
    requires: "accessToken"
  },

  d5300: {
    id: "d5300",
    type: "diamonds",
    name: "5.300 Diamantes",
    amount: "5300",
    price: 139.90,
    requires: "accessToken"
  },

  d11200: {
    id: "d11200",
    type: "diamonds",
    name: "11.200 Diamantes",
    amount: "11200",
    price: 279.90,
    requires: "accessToken"
  },

  d22400: {
    id: "d22400",
    type: "diamonds",
    name: "22.400 Diamantes",
    amount: "22400",
    price: 529.90,
    requires: "accessToken"
  },

  token: {
    id: "token",
    type: "token",
    name: "Token (Caixa Universal)",
    quantity: 1,
    price: 4.90,
    requires: "playerId"
  },

  pass: {
    id: "pass",
    type: "pass",
    name: "Passe Booyah",
    price: 6.90,
    requires: "playerId"
  }
};


// ======================================================
// ARMAZENAMENTO TEMPORÁRIO DOS PEDIDOS
// ======================================================

const orders = new Map();

// Evita processar o mesmo webhook duas vezes
const processedEvents = new Set();


// ======================================================
// EXPRESS
// ======================================================

app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(
  express.json({
    limit: "1mb"
  })
);


// ======================================================
// FUNÇÕES AUXILIARES
// ======================================================

function configured() {

  const missing = [];

  if (!FREEFIRE_USER_ID) {
    missing.push("FREEFIRE_USER_ID");
  }

  if (!FREEFIRE_API_KEY) {
    missing.push("FREEFIRE_API_KEY");
  }

  if (!ASAAS_API_KEY) {
    missing.push("ASAAS_API_KEY");
  }

  if (
    !ORDER_SECRET ||
    ORDER_SECRET.length < 32
  ) {
    missing.push(
      "ORDER_SECRET (mínimo 32 caracteres)"
    );
  }

  if (missing.length) {
    throw new Error(
      "Configure no Render: " +
      missing.join(", ")
    );
  }
}


function baseUrl(req) {

  return (
    PUBLIC_URL ||
    `${req.protocol}://${req.get("host")}`
  );

}


function safeEqual(a, b) {

  if (!a || !b) {
    return false;
  }

  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));

  return (
    aa.length === bb.length &&
    crypto.timingSafeEqual(aa, bb)
  );

}


// ======================================================
// CRIPTOGRAFIA DO PEDIDO
// ======================================================

function encrypt(value) {

  const key =
    crypto
      .createHash("sha256")
      .update(ORDER_SECRET)
      .digest();

  const iv =
    crypto.randomBytes(12);

  const cipher =
    crypto.createCipheriv(
      "aes-256-gcm",
      key,
      iv
    );

  const ciphertext =
    Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final()
    ]);

  const tag =
    cipher.getAuthTag();

  return Buffer.concat([
    iv,
    tag,
    ciphertext
  ]).toString("base64url");

}


function decrypt(value) {

  const key =
    crypto
      .createHash("sha256")
      .update(ORDER_SECRET)
      .digest();

  const raw =
    Buffer.from(
      value,
      "base64url"
    );

  const iv =
    raw.subarray(0, 12);

  const tag =
    raw.subarray(12, 28);

  const ciphertext =
    raw.subarray(28);

  const decipher =
    crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      iv
    );

  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]).toString("utf8");

}


// ======================================================
// REQUEST JSON
// ======================================================

async function requestJson(
  url,
  options
) {

  const response =
    await fetch(
      url,
      options
    );

  const text =
    await response.text();

  let data;

  try {

    data =
      text
        ? JSON.parse(text)
        : {};

  } catch (_) {

    data = {
      raw: text
    };

  }


  if (!response.ok) {

    let detail =
      data?.errors
        ?.map?.(
          e => e.description
        )
        .join(" ");

    detail =
      detail ||
      data?.error ||
      data?.message ||
      `HTTP ${response.status}`;

    throw new Error(detail);

  }


  return data;

}


// ======================================================
// FREEFIRE SHOP
// ======================================================

async function freeFire(
  endpoint,
  body
) {

  configured();

  return requestJson(
    `${FREEFIRE_API_URL}${endpoint}`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        "Accept":
          "application/json"
      },

      body: JSON.stringify({

        userId:
          FREEFIRE_USER_ID,

        key:
          FREEFIRE_API_KEY,

        ...body

      })
    }
  );

}


// ======================================================
// ASAAS
// ======================================================

async function asaas(
  endpoint,
  body
) {

  if (!ASAAS_API_KEY) {

    throw new Error(
      "ASAAS_API_KEY não configurada."
    );

  }

  return requestJson(
    `${ASAAS_API_URL}${endpoint}`,
    {
      method: "POST",

      headers: {

        "Content-Type":
          "application/json",

        "Accept":
          "application/json",

        "access_token":
          ASAAS_API_KEY

      },

      body:
        JSON.stringify(body)

    }
  );

}


// ======================================================
// ENTREGA AUTOMÁTICA
// ======================================================

async function deliver(order) {

  if (!order) {
    return order;
  }

  if (order.status !== "paid") {
    return order;
  }

  if (
    order.deliveryStatus ===
    "delivered"
  ) {
    return order;
  }


  orders.set(
    order.id,
    {
      ...order,

      deliveryStatus:
        "processing",

      updatedAt:
        new Date().toISOString()
    }
  );


  try {

    let result;


    // ----------------------------------------------
    // DIAMANTES
    // ----------------------------------------------

    if (
      order.type ===
      "diamonds"
    ) {

      result =
        await freeFire(
          "/api/v1/diamonds/send",
          {

            accessToken:
              order.accessToken,

            diamondAmount:
              order.amount

          }
        );

    }


    // ----------------------------------------------
    // TOKEN
    // ----------------------------------------------

    else if (
      order.type ===
      "token"
    ) {

      result =
        await freeFire(
          "/api/v1/tokens/send",
          {

            playerID:
              order.playerId,

            quantity:
              Number(
                order.quantity || 1
              ),

            mensagem:
              `Pedido ${order.id}`

          }
        );

    }


    // ----------------------------------------------
    // PASSE BOOYAH
    // ----------------------------------------------

    else if (
      order.type ===
      "pass"
    ) {

      result =
        await freeFire(
          "/api/v1/pass/send",
          {

            uid:
              order.playerId

          }
        );

    }


    else {

      throw new Error(
        "Tipo de produto inválido."
      );

    }


    const current =
      orders.get(order.id);


    const updated = {

      ...current,

      deliveryStatus:
        "delivered",

      supplierTransactionId:
        result?.transacao?.id ||
        result?.transaction?.id ||
        null,

      supplierResponse:
        result,

      deliveredAt:
        new Date().toISOString(),

      updatedAt:
        new Date().toISOString()

    };


    orders.set(
      order.id,
      updated
    );


    console.log(
      `Entrega concluída: ${order.id}`
    );


    return updated;


  } catch (error) {

    console.error(
      "Erro na entrega automática:",
      error
    );


    const current =
      orders.get(order.id);


    const updated = {

      ...current,

      deliveryStatus:
        "failed",

      deliveryError:
        error.message,

      updatedAt:
        new Date().toISOString()

    };


    orders.set(
      order.id,
      updated
    );


    return updated;

  }

}


// ======================================================
// REMOVE DADOS SENSÍVEIS DA RESPOSTA
// ======================================================

function publicOrder(order) {

  if (!order) {
    return null;
  }

  const safe = {
    ...order
  };

  delete safe.accessToken;
  delete safe.externalReference;
  delete safe.supplierResponse;

  return safe;

}


// ======================================================
// HEALTH CHECK
// ======================================================

app.get(
  "/health",
  (req, res) => {

    res.json({

      ok: true,

      store:
        STORE_NAME,

      freeFireConfigured:
        Boolean(
          FREEFIRE_USER_ID &&
          FREEFIRE_API_KEY
        ),

      asaasConfigured:
        Boolean(
          ASAAS_API_KEY
        ),

      orderSecretConfigured:
        Boolean(
          ORDER_SECRET.length >= 32
        )

    });

  }
);


// ======================================================
// PRODUTOS
// ======================================================

app.get(
  "/api/products",
  (req, res) => {

    res.json({

      ok: true,

      products:
        Object.values(
          products
        )

    });

  }
);


// ======================================================
// VERIFICAR TOKEN DO JOGADOR
// ======================================================

app.post(
  "/api/verify-player",
  async (req, res) => {

    try {

      const {
        accessToken,
        diamondAmount
      } = req.body || {};


      if (
        !String(
          accessToken || ""
        ).trim()
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "Informe o accessToken do jogador."

        });

      }


      const data =
        await freeFire(
          "/api/v1/diamonds/verify",
          {

            accessToken:
              String(
                accessToken
              ),

            ...(diamondAmount
              ? {
                  diamondAmount:
                    String(
                      diamondAmount
                    )
                }
              : {})

          }
        );


      res.json({

        ok: true,

        data

      });


    } catch (error) {

      console.error(
        "Erro ao verificar jogador:",
        error
      );


      res.status(400).json({

        ok: false,

        error:
          error.message

      });

    }

  }
);


// ======================================================
// CRIAR PEDIDO
// ======================================================

app.post(
  "/api/orders",
  async (req, res) => {

    try {

      const {
        productId,
        playerId,
        accessToken
      } = req.body || {};


      // ----------------------------------------------
      // PRODUTO
      // ----------------------------------------------

      const product =
        products[productId];


      if (!product) {

        return res.status(400).json({

          ok: false,

          error:
            "Produto inválido."

        });

      }


      // ----------------------------------------------
      // PLAYER ID
      // ----------------------------------------------

      if (
        !/^\d{5,15}$/.test(
          String(
            playerId || ""
          )
        )
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "Player ID inválido."

        });

      }


      // ----------------------------------------------
      // ACCESS TOKEN PARA DIAMANTES
      // ----------------------------------------------

      if (
        product.type ===
        "diamonds"
      ) {

        if (
          !String(
            accessToken || ""
          ).trim()
        ) {

          return res.status(400).json({

            ok: false,

            error:
              "Para diamantes, informe o token de acesso do jogador."

          });

        }

      }


      configured();


      // ----------------------------------------------
      // ID DO PEDIDO
      // ----------------------------------------------

      const orderId =
        `VZ-${Date.now()}-${crypto
          .randomBytes(3)
          .toString("hex")}`;


      // ----------------------------------------------
      // REFERÊNCIA CRIPTOGRAFADA
      // ----------------------------------------------

      const secretReference =
        encrypt(
          JSON.stringify({

            id:
              orderId,

            productId:
              product.id,

            type:
              product.type,

            amount:
              product.amount ||
              null,

            quantity:
              product.quantity ||
              null,

            playerId:
              String(
                playerId
              ),

            accessToken:
              product.type ===
              "diamonds"

                ? String(
                    accessToken
                  )

                : ""

          })
        );


      // ----------------------------------------------
      // PEDIDO
      // ----------------------------------------------

      const order = {

        id:
          orderId,

        productId:
          product.id,

        type:
          product.type,

        productName:
          product.name,

        amount:
          product.amount ||
          null,

        quantity:
          product.quantity ||
          null,

        playerId:
          String(
            playerId
          ),

        accessToken:
          product.type ===
          "diamonds"

            ? String(
                accessToken
              )

            : "",

        price:
          product.price,

        status:
          "pending_payment",

        deliveryStatus:
          "waiting_payment",

        externalReference:
          secretReference,

        createdAt:
          new Date().toISOString(),

        updatedAt:
          new Date().toISOString()

      };


      orders.set(
        orderId,
        order
      );


      // ----------------------------------------------
      // CRIAR CHECKOUT ASAAS
      // ----------------------------------------------

      const url =
        baseUrl(req);


      const checkout =
        await asaas(
          "/checkouts",
          {

            billingTypes: [
              "PIX",
              "CREDIT_CARD"
            ],

            chargeTypes: [
              "DETACHED"
            ],

            minutesToExpire:
              60,

            externalReference:
              secretReference,

            callback: {

              successUrl:
                `${url}/?payment=success&order=${encodeURIComponent(
                  orderId
                )}`,

              cancelUrl:
                `${url}/?payment=cancelled&order=${encodeURIComponent(
                  orderId
                )}`,

              expiredUrl:
                `${url}/?payment=expired&order=${encodeURIComponent(
                  orderId
                )}`

            },

            items: [

              {

                externalReference:
                  product.id,

                name:
                  product.name,

                description:
                  `Pedido ${orderId}`,

                quantity:
                  1,

                value:
                  product.price

              }

            ]

          }
        );


      // ----------------------------------------------
      // LINK DO CHECKOUT
      // ----------------------------------------------

      const checkoutLink =
        checkout.link ||
        `https://asaas.com/checkoutSession/show?id=${checkout.id}`;


      orders.set(

        orderId,

        {

          ...order,

          checkoutId:
            checkout.id,

          checkoutLink:
            checkoutLink,

          updatedAt:
            new Date().toISOString()

        }

      );


      console.log(
        `Pedido criado: ${orderId}`
      );


      res.json({

        ok: true,

        orderId:

          orderId,

        checkout: {

          id:
            checkout.id,

          link:
            checkoutLink

        }

      });


    } catch (error) {

      console.error(
        "Erro ao criar pedido:",
        error
      );


      res.status(500).json({

        ok: false,

        error:
          error.message

      });

    }

  }
);


// ======================================================
// CONSULTAR PEDIDO
// ======================================================

app.get(
  "/api/orders/:id",
  (req, res) => {

    const order =
      orders.get(
        req.params.id
      );


    if (!order) {

      return res.status(404).json({

        ok: false,

        error:
          "Pedido não encontrado."

      });

    }


    res.json({

      ok: true,

      order:
        publicOrder(order)

    });

  }
);


// ======================================================
// WEBHOOK ASAAS
// ======================================================

app.post(
  "/api/webhooks/asaas",
  async (req, res) => {

    try {

      // --------------------------------------------
      // SEGURANÇA DO WEBHOOK
      // --------------------------------------------

      if (
        WEBHOOK_AUTH_TOKEN
      ) {

        const received =
          req.get(
            "asaas-access-token"
          ) ||
          req
            .get("Authorization")
            ?.replace(
              /^Bearer\s+/i,
          
