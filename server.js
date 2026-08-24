require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const path = require("path");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 3000;

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

app.use(express.static(__dirname));

/* =====================================================
   CONFIGURAÇÕES
===================================================== */

const FAZERCARDS_API_URL = (
  process.env.SUPPLIER_API_URL ||
  "https://api.fzr.cards/api/v2"
).replace(/\/$/, "");

const FAZERCARDS_API_KEY =
  process.env.SUPPLIER_API_KEY || "";

const FAZERCARDS_CATEGORY_ID =
  process.env.FAZERCARDS_CATEGORY_ID ||
  "free_fire_br";

const USD_BRL_RATE =
  Number(process.env.USD_BRL_RATE || "5.50");

const MARKUP_PERCENT =
  Number(process.env.MARKUP_PERCENT || "30");

const ASAAS_API_URL = (
  process.env.ASAAS_API_URL ||
  "https://api.asaas.com/v3"
).replace(/\/$/, "");

const ASAAS_API_KEY =
  process.env.ASAAS_API_KEY || "";

const APP_URL = (
  process.env.APP_URL || ""
).replace(/\/$/, "");


/* =====================================================
   CACHE DO CATÁLOGO
===================================================== */

let catalogCache = {
  products: [],
  fields: [],
  loadedAt: 0
};

const CATALOG_TTL =
  5 * 60 * 1000;


/* =====================================================
   PEDIDOS
===================================================== */

const orders = new Map();

const processedEvents = new Set();


/* =====================================================
   CONFIGURAÇÃO
===================================================== */

function checkConfig() {

  const missing = [];

  if (!FAZERCARDS_API_KEY)
    missing.push("SUPPLIER_API_KEY");

  if (!ASAAS_API_KEY)
    missing.push("ASAAS_API_KEY");

  if (!APP_URL)
    missing.push("APP_URL");

  if (
    !Number.isFinite(USD_BRL_RATE) ||
    USD_BRL_RATE <= 0
  ) {
    missing.push("USD_BRL_RATE");
  }

  if (
    !Number.isFinite(MARKUP_PERCENT) ||
    MARKUP_PERCENT < 0
  ) {
    missing.push("MARKUP_PERCENT");
  }

  if (missing.length) {

    throw new Error(
      "Variáveis ausentes: " +
      missing.join(", ")
    );

  }

}


/* =====================================================
   REQUEST JSON
===================================================== */

async function requestJson(
  url,
  options = {}
) {

  const response =
    await fetch(
      url,
      options
    );

  const text =
    await response.text();

  let data = {};

  try {

    data =
      text
        ? JSON.parse(text)
        : {};

  } catch {

    data = {
      raw: text
    };

  }

  if (!response.ok) {

    const message =
      data?.error ||
      data?.message ||
      data?.errors
        ?.map?.(
          e =>
            e.description ||
            e.message ||
            String(e)
        )
        .join(" ") ||
      `HTTP ${response.status}`;

    throw new Error(message);

  }

  return data;

}


/* =====================================================
   FAZERCARDS
===================================================== */

async function fazerCardsRequest(
  endpoint,
  options = {}
) {

  if (!FAZERCARDS_API_KEY) {

    throw new Error(
      "SUPPLIER_API_KEY não configurada."
    );

  }

  return requestJson(
    `${FAZERCARDS_API_URL}${endpoint}`,
    {

      ...options,

      headers: {

        accept:
          "application/json",

        "content-type":
          "application/json",

        "X-API-Key":
          FAZERCARDS_API_KEY,

        ...(options.headers || {})

      }

    }
  );

}


/* =====================================================
   ASAAS
===================================================== */

async function asaasRequest(
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

        accept:
          "application/json",

        "content-type":
          "application/json",

        access_token:
          ASAAS_API_KEY

      },

      body:
        JSON.stringify(body)

    }
  );

}


/* =====================================================
   ID DO PEDIDO
===================================================== */

function createOrderId() {

  return (
    "VZ-" +
    Date.now().toString(36).toUpperCase() +
    "-" +
    crypto
      .randomBytes(3)
      .toString("hex")
      .toUpperCase()
  );

}


/* =====================================================
   PREÇO
===================================================== */

function calculateRetailPrice(
  usdPrice
) {

  const usd =
    Number(usdPrice);

  if (
    !Number.isFinite(usd) ||
    usd <= 0
  ) {

    throw new Error(
      "Preço inválido recebido do FazerCards."
    );

  }

  const costBrl =
    usd * USD_BRL_RATE;

  const retail =
    costBrl *
    (
      1 +
      MARKUP_PERCENT / 100
    );

  return Number(
    retail.toFixed(2)
  );

}


/* =====================================================
   CARREGAR CATÁLOGO FAZERCARDS
===================================================== */

async function loadFazerCardsProducts(
  force = false
) {

  const now =
    Date.now();

  if (
    !force &&
    catalogCache.products.length &&
    now - catalogCache.loadedAt <
      CATALOG_TTL
  ) {

    return catalogCache;

  }

  const data =
    await fazerCardsRequest(
      `/topups/offers?category_id=${encodeURIComponent(
        FAZERCARDS_CATEGORY_ID
      )}`,
      {
        method: "GET"
      }
    );


  if (!data.ok) {

    throw new Error(
      data.error ||
      "FazerCards não retornou as ofertas."
    );

  }


  const offers =
    Array.isArray(data.offers)
      ? data.offers
      : [];


  const fields =
    Array.isArray(data.fields)
      ? data.fields
      : [];


  const products =
    offers
      .map(
        (offer, index) => {

          const usdPrice =
            Number(
              offer.price_usd
            );

          if (
            !Number.isFinite(
              usdPrice
            ) ||
            usdPrice <= 0
          ) {

            return null;

          }


          let retailPrice;

          try {

            retailPrice =
              calculateRetailPrice(
                usdPrice
              );

          } catch {

            return null;

          }


          return {

            id:
              String(
                offer.offer_id
              ),

            offerId:
              String(
                offer.offer_id
              ),

            categoryId:
              FAZERCARDS_CATEGORY_ID,

            type:
              "diamonds",

            name:
              offer.name ||
              `Oferta ${index + 1}`,

            price:
              retailPrice,

            supplierPriceUsd:
              usdPrice,

            requires:
              "playerId"

          };

        }
      )
      .filter(Boolean);


  catalogCache = {

    products,

    fields,

    loadedAt:
      now

  };


  console.log(
    `FazerCards: ${products.length} ofertas carregadas.`
  );


  return catalogCache;

}


/* =====================================================
   CAMPOS DO PEDIDO
===================================================== */

function buildTopupFields(
  playerId
) {

  const fields =
    catalogCache.fields || [];


  if (!fields.length) {

    throw new Error(
      "O FazerCards não informou os campos necessários."
    );

  }


  const result = {};


  for (
    const field of fields
  ) {

    const key =
      String(
        field.key || ""
      ).trim();


    if (!key) continue;


    if (
      key === "player_id" ||
      key === "playerId" ||
      key === "uid" ||
      key === "user_id" ||
      key === "userId" ||
      key === "role_id" ||
      key === "roleId"
    ) {

      result[key] =
        playerId;

    }

  }


  if (
    Object.keys(result).length === 0 &&
    fields.length === 1
  ) {

    result[
      fields[0].key
    ] =
      playerId;

  }


  if (
    Object.keys(result).length === 0
  ) {

    throw new Error(
      "Não consegui identificar automaticamente o campo do Player ID."
    );

  }


  return result;

}


/* =====================================================
   VALIDAR PLAYER ID
===================================================== */

async function validatePlayerId(
  playerId
) {

  const fields =
    buildTopupFields(
      playerId
    );


  const data =
    await fazerCardsRequest(
      "/topups/validate-id",
      {

        method:
          "POST",

        headers: {

          "Idempotency-Key":
            crypto.randomUUID()

        },

        body:
          JSON.stringify({

            category_id:
              FAZERCARDS_CATEGORY_ID,

            fields

          })

      }
    );


  return {

    valid:
      data.valid !== false,

    playerName:
      data.player_name ||
      null,

    region:
      data.region ||
      null

  };

}


/* =====================================================
   CRIAR PEDIDO FAZERCARDS
===================================================== */

async function createFazerCardsOrder(
  order
) {

  const fields =
    buildTopupFields(
      order.playerId
    );


  const data =
    await fazerCardsRequest(
      "/topups/order",
      {

        method:
          "POST",

        headers: {

          "Idempotency-Key":
            order.id

        },

        body:
          JSON.stringify({

            category_id:
              order.categoryId,

            offer_id:
              order.offerId,

            fields

          })

      }
    );


  if (!data.ok) {

    throw new Error(
      data.error ||
      "FazerCards recusou o pedido."
    );

  }


  return data;

}


/* =====================================================
   CONSULTAR PEDIDO FAZERCARDS
===================================================== */

async function getFazerCardsOrder(
  supplierOrderId
) {

  return fazerCardsRequest(
    `/orders/${encodeURIComponent(
      supplierOrderId
    )}`,
    {
      method: "GET"
    }
  );

}


/* =====================================================
   MONITORAR ENTREGA
===================================================== */

async function monitorSupplierOrder(
  localOrderId,
  supplierOrderId
) {

  const maxAttempts =
    24;

  const interval =
    5000;


  for (
    let attempt = 0;
    attempt < maxAttempts;
    attempt++
  ) {

    try {

      const data =
        await getFazerCardsOrder(
          supplierOrderId
        );


      const supplierOrder =
        data.order ||
        data;


      const status =
        String(
          supplierOrder.status ||
          ""
        ).toLowerCase();


      const current =
        orders.get(
          localOrderId
        );


      if (!current) {

        return;

      }


      orders.set(
        localOrderId,
        {

          ...current,

          supplierStatus:
            supplierOrder.status,

          supplierOrder

        }
      );


      if (
        status === "completed" ||
        status === "complete" ||
        status === "delivered"
      ) {

        orders.set(
          localOrderId,
          {

            ...current,

            supplierStatus:
              supplierOrder.status,

            deliveryStatus:
              "delivered",

            status:
              "completed",

            completedAt:
              new Date().toISOString(),

            supplierOrder

          }
        );


        console.log(
          "Entrega concluída:",
          localOrderId
        );


        return;

      }


      if (
        status === "failed" ||
        status === "refunded" ||
        status === "cancelled"
      ) {

        orders.set(
          localOrderId,
          {

            ...current,

            supplierStatus:
              supplierOrder.status,

            deliveryStatus:
              "failed",

            status:
              status,

            supplierOrder

          }
        );


        console.log(
          "Pedido do fornecedor finalizado:",
          localOrderId,
          status
        );


        return;

      }

    } catch (error) {

      console.error(
        "Erro consultando FazerCards:",
        error.message
      );

    }


    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          interval
        )
    );

  }

}


/* =====================================================
   PRODUTOS
===================================================== */

app.get(
  "/api/products",
  async (req, res) => {

    try {

      const catalog =
        await loadFazerCardsProducts();


      res.json({

        ok: true,

        categoryId:
          FAZERCARDS_CATEGORY_ID,

        fields:
          catalog.fields,

        products:
          catalog.products

      });

    } catch (error) {

      console.error(
        "Erro carregando produtos:",
        error
      );

      res.status(500).json({

        ok: false,

        error:
          error.message ||
          "Não foi possível carregar os produtos."

      });

    }

  }
);


/* =====================================================
   ATUALIZAR CATÁLOGO
===================================================== */

app.get(
  "/api/products/refresh",
  async (req, res) => {

    try {

      const catalog =
        await loadFazerCardsProducts(
          true
        );


      res.json({

        ok: true,

        products:
          catalog.products,

        fields:
          catalog.fields,

        count:
          catalog.products.length

      });

    } catch (error) {

      res.status(500).json({

        ok: false,

        error:
          error.message

      });

    }

  }
);


/* =====================================================
   CONFIGURAÇÃO
===================================================== */

app.get(
  "/api/config",
  (req, res) => {

    res.json({

      ok: true,

      storeName:
        "VIBEZ DIAMONDS",

      supplier:
        "FazerCards",

      categoryId:
        FAZERCARDS_CATEGORY_ID,

      supplierConfigured:
        Boolean(
          FAZERCARDS_API_KEY
        ),

      paymentConfigured:
        Boolean(
          ASAAS_API_KEY
        )

    });

  }
);


/* =====================================================
   CRIAR PEDIDO
===================================================== */

app.post(
  "/api/orders",
  async (req, res) => {

    try {

      checkConfig();


      const {
        productId,
        playerId
      } =
        req.body || {};


      const cleanPlayerId =
        String(
          playerId || ""
        ).trim();


      if (
        !/^\d{5,15}$/.test(
          cleanPlayerId
        )
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "Player ID inválido."

        });

      }


      const catalog =
        await loadFazerCardsProducts();


      const product =
        catalog.products.find(
          item =>
            item.id ===
            String(productId)
        );


      if (!product) {

        return res.status(400).json({

          ok: false,

          error:
            "Produto inválido ou não está mais disponível."

        });

      }


      let validation;

      try {

        validation =
          await validatePlayerId(
            cleanPlayerId
          );

      } catch (validationError) {

        return res.status(400).json({

          ok: false,

          error:
            "Não foi possível validar o Player ID: " +
            validationError.message

        });

      }


      if (
        validation.valid === false
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "Player ID inválido no FazerCards."

        });

      }


      const orderId =
        createOrderId();


      const order = {

        id:
          orderId,

        productId:
          product.id,

        offerId:
          product.offerId,

        categoryId:
          product.categoryId,

        productName:
          product.name,

        type:
          product.type,

        playerId:
          cleanPlayerId,

        playerName:
          validation.playerName,

        region:
          validation.region,

        supplierPriceUsd:
          product.supplierPriceUsd,

        price:
          product.price,

        status:
          "waiting_payment",

        deliveryStatus:
          "waiting_payment",

        createdAt:
          new Date().toISOString()

      };


      orders.set(
        orderId,
        order
      );


      /* =================================================
         CHECKOUT ASAAS
      ================================================= */

      const checkout =
        await asaasRequest(
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
              orderId,

            callback: {

              successUrl:
                `${APP_URL}/?payment=success&order=${encodeURIComponent(
                  orderId
                )}`,

              cancelUrl:
                `${APP_URL}/?payment=cancelled&order=${encodeURIComponent(
                  orderId
                )}`,

              expiredUrl:
                `${APP_URL}/?payment=expired&order=${encodeURIComponent(
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
                  `Pedido VIBEZ DIAMONDS ${orderId}`,

                quantity:
                  1,

                value:
                  product.price

              }

            ]

          }
        );


      const checkoutLink =
        checkout.link ||
        (
          checkout.id
            ? `https://asaas.com/checkoutSession/show?id=${encodeURIComponent(
                checkout.id
              )}`
            : null
        );


      if (!checkoutLink) {

        throw new Error(
          "Asaas não retornou o link do checkout."
        );

      }


      orders.set(
        orderId,
        {

          ...order,

          checkoutId:
            checkout.id,

          checkoutLink

        }
      );


      res.json({

        ok: true,

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
          error.message ||
          "Erro ao criar pagamento."

      });

    }

  }
);


/* =====================================================
   CONSULTAR PEDIDO
===================================================== */

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


    const safeOrder = {
      ...order
    };


    delete safeOrder.supplierResponse;


    res.json({

      ok: true,

      order:
        safeOrder

    });

  }
);


/* =====================================================
   WEBHOOK ASAAS
===================================================== */

app.post(
  "/api/webhooks/as
