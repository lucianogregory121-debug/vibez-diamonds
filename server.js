require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const path = require("path");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 3000;

const ASAAS_API_URL =
  process.env.ASAAS_API_URL ||
  "https://api.asaas.com/v3";

const FAZER_API_URL =
  process.env.FAZER_API_URL ||
  "https://api.fzr.cards/api/v2";

app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

/*
  Guardamos o corpo bruto para que o webhook
  do Asaas possa ser auditado/validado.
*/
app.use(
  express.json({
    limit: "1mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);

app.use(express.static(__dirname));

/* =========================================================
   PRODUTOS DA VIBEZ
========================================================= */

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

/* =========================================================
   PEDIDOS
========================================================= */

/*
  IMPORTANTE:
  Este armazenamento é temporário.
  Para produção real, recomendamos PostgreSQL.
*/
const orders = new Map();

/* =========================================================
   CONFIGURAÇÃO
========================================================= */

function asaasConfigured() {
  return Boolean(process.env.ASAAS_API_KEY);
}

function fazerConfigured() {
  return Boolean(process.env.FAZER_API_KEY);
}

function getBaseUrl(req) {
  const url =
    process.env.PUBLIC_URL ||
    `${req.protocol}://${req.get("host")}`;

  return url.replace(/\/$/, "");
}

/* =========================================================
   ASAAS REQUEST
========================================================= */

async function asaasRequest(endpoint, options = {}) {
  if (!process.env.ASAAS_API_KEY) {
    throw new Error(
      "ASAAS_API_KEY não configurada."
    );
  }

  const response = await fetch(
    `${ASAAS_API_URL}${endpoint}`,
    {
      ...options,

      headers: {
        accept: "application/json",
        "content-type": "application/json",
        access_token:
          process.env.ASAAS_API_KEY,

        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();

  let data = {};

  try {
    data = text
      ? JSON.parse(text)
      : {};
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    console.error(
      "ASAAS ERROR:",
      response.status,
      data
    );

    const message =
      data?.errors
        ?.map?.(
          error =>
            error.description
        )
        .join(" ") ||
      data?.message ||
      "Erro na API do Asaas.";

    throw new Error(message);
  }

  return data;
}

/* =========================================================
   FAZERCARDS REQUEST
========================================================= */

async function fazerRequest(
  endpoint,
  options = {}
) {
  if (!process.env.FAZER_API_KEY) {
    throw new Error(
      "FAZER_API_KEY não configurada."
    );
  }

  const response = await fetch(
    `${FAZER_API_URL}${endpoint}`,
    {
      ...options,

      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "X-API-Key":
          process.env.FAZER_API_KEY,

        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();

  let data = {};

  try {
    data = text
      ? JSON.parse(text)
      : {};
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    console.error(
      "FAZERCARDS ERROR:",
      response.status,
      data
    );

    throw new Error(
      data?.error ||
      "Erro na API da FazerCards."
    );
  }

  return data;
}

/* =========================================================
   ASAAS CHECKOUT LINK
========================================================= */

function getAsaasCheckoutLink(checkout) {
  if (checkout?.link) {
    return checkout.link;
  }

  if (!checkout?.id) {
    return null;
  }

  const isSandbox =
    ASAAS_API_URL.includes("sandbox");

  const domain = isSandbox
    ? "https://sandbox.asaas.com"
    : "https://asaas.com";

  return (
    `${domain}/checkoutSession/show?id=` +
    encodeURIComponent(checkout.id)
  );
}

/* =========================================================
   CONFIG
========================================================= */

app.get(
  "/api/config",
  (req, res) => {
    res.json({
      storeName:
        process.env.STORE_NAME ||
        "VIBEZ DIAMONDS",

      asaasConfigured:
        asaasConfigured(),

      fazerCardsConfigured:
        fazerConfigured(),

      paymentProvider:
        "Asaas",

      supplier:
        "FazerCards"
    });
  }
);

/* =========================================================
   PRODUTOS
========================================================= */

app.get(
  "/api/products",
  (req, res) => {
    res.json({
      products
    });
  }
);

/* =========================================================
   TESTE DA FAZERCARDS
========================================================= */

/*
  NÃO FAZ COMPRA.
  Apenas consulta as categorias disponíveis.
*/

app.get(
  "/api/fazer/test",
  async (req, res) => {
    try {
      if (!fazerConfigured()) {
        return res.status(500).json({
          ok: false,
          error:
            "FAZER_API_KEY não configurada."
        });
      }

      const data =
        await fazerRequest(
          "/topups?limit=100"
        );

      const items =
        Array.isArray(data.items)
          ? data.items
          : [];

      const freeFire =
        items.filter(item =>
          String(
            item.name || ""
          )
            .toLowerCase()
            .includes("free fire")
        );

      return res.json({
        ok: true,

        totalCategorias:
          items.length,

        freeFire,

        message:
          "Consulta realizada sem criar pedido."
      });

    } catch (error) {
      console.error(
        "Erro no teste FazerCards:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   OFERTAS FREE FIRE
========================================================= */

app.get(
  "/api/fazer/freefire/offers",
  async (req, res) => {
    try {
      const categoryId =
        String(
          req.query.category_id ||
          process.env.FAZER_FREEFIRE_CATEGORY_ID ||
          ""
        ).trim();

      if (!categoryId) {
        return res.status(400).json({
          ok: false,
          error:
            "Informe category_id ou configure FAZER_FREEFIRE_CATEGORY_ID."
        });
      }

      const data =
        await fazerRequest(
          `/topups/offers?category_id=${encodeURIComponent(
            categoryId
          )}`
        );

      return res.json(data);

    } catch (error) {
      console.error(
        "Erro ao consultar ofertas:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   VALIDAR ID FREE FIRE
========================================================= */

app.post(
  "/api/fazer/freefire/validate",
  async (req, res) => {
    try {
      const categoryId =
        String(
          req.body.category_id ||
          process.env.FAZER_FREEFIRE_CATEGORY_ID ||
          ""
        ).trim();

      const playerId =
        String(
          req.body.playerId || ""
        ).trim();

      if (!categoryId) {
        return res.status(400).json({
          ok: false,
          error:
            "Categoria Free Fire não configurada."
        });
      }

      if (!/^\d{5,15}$/.test(playerId)) {
        return res.status(400).json({
          ok: false,
          error:
            "ID de jogador inválido."
        });
      }

      const data =
        await fazerRequest(
          "/topups/validate-id",
          {
            method: "POST",

            body: JSON.stringify({
              category_id:
                categoryId,

              fields: {
                player_id:
                  playerId
              }
            })
          }
        );

      return res.json(data);

    } catch (error) {
      console.error(
        "Erro ao validar ID:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   CRIAR CHECKOUT ASAAS
========================================================= */

app.post(
  "/api/orders",
  async (req, res) => {
    try {
      const {
        playerId,
        productId,
        paymentMethod
      } = req.body;

      if (
        !playerId ||
        !productId ||
        !paymentMethod
      ) {
        return res.status(400).json({
          error:
            "Preencha todos os dados."
        });
      }

      const cleanPlayerId =
        String(playerId).trim();

      if (
        !/^\d{5,15}$/.test(
          cleanPlayerId
        )
      ) {
        return res.status(400).json({
          error:
            "Digite um ID de jogador válido."
        });
      }

      const product =
        products.find(
          item =>
            item.id === productId
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

      if (!asaasConfigured()) {
        return res.status(500).json({
          error:
            "Pagamento Asaas não configurado."
        });
      }

      const orderId =
        "VZ-" +
        Date.now()
          .toString(36)
          .toUpperCase() +
        "-" +
        crypto
          .randomBytes(3)
          .toString("hex")
          .toUpperCase();

      const baseUrl =
        getBaseUrl(req);

      const billingTypes =
        paymentMethod === "pix"
          ? ["PIX"]
          : ["CREDIT_CARD"];

      /*
        Guardamos os dados antes de criar
        o checkout.
      */

      orders.set(orderId, {
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
          "waiting_payment",

        createdAt:
          new Date().toISOString(),

        supplierOrderId:
          null
      });

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
                    `VIBEZ DIAMONDS - ID ${cleanPlayerId}`,

                  quantity: 1,

                  value:
                    product.price
                }
              ]
            })
          }
        );

      const checkoutLink =
        getAsaasCheckoutLink(
          checkout
        );

      if (!checkoutLink) {
        throw new Error(
          "Asaas não retornou o link do Checkout."
        );
      }

      const savedOrder =
        orders.get(orderId);

      savedOrder.asaasCheckoutId =
        checkout.id;

      savedOrder.asaasCheckoutStatus =
        checkout.status;

      orders.set(
        orderId,
        savedOrder
      );

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
        "Jogador:",
        cleanPlayerId
      );

      console.log(
        "Produto:",
        product.diamonds
      );

      console.log(
        "Checkout:",
        checkout.id
      );

      console.log(
        "================================"
      );

      return res.json({
        ok: true,

        order: {
          id:
            orderId,

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
        "ERRO AO CRIAR PEDIDO:",
        error
      );

      return res.status(500).json({
        error:
          error.message ||
          "Não foi possível criar o pagamento."
      });
    }
  }
);

/* =========================================================
   CONSULTAR PEDIDO
========================================================= */

app.get(
  "/api/orders/:orderId",
  (req, res) => {
    const order =
      orders.get(
        req.params.orderId
      );

    if (!order) {
      return res.status(404).json({
        ok: false,
        error:
          "Pedido não encontrado."
      });
    }

    return res.json({
      ok: true,
      order
    });
  }
);

/* =========================================================
   WEBHOOK ASAAS
========================================================= */

app.post(
  "/webhooks/asaas",
  async (req, res) => {
    try {
      const configuredToken =
        process.env.ASAAS_WEBHOOK_TOKEN;

      /*
        Se configurado no Render,
        valida o token enviado pelo Asaas.
      */

      if (configuredToken) {
        const receivedToken =
          req.headers[
            "asaas-access-token"
          ];

        if (
          receivedToken !==
          configuredToken
        ) {
          console.warn(
            "Webhook Asaas rejeitado: token inválido."
          );

          return res.status(401).json({
            error:
              "Webhook não autorizado."
          });
        }
      }

      const event =
        req.body || {};

      const eventType =
        event.event;

      const payment =
        event.payment || {};

      console.log(
        "================================"
      );

      console.log(
        "WEBHOOK ASAAS"
      );

      console.log(
        "Evento:",
        eventType
      );

      console.log(
        "Pagamento:",
        payment.id
      );

      console.log(
        "Status:",
        payment.status
      );

      console.log(
        "================================"
      );

      /*
        Somente PAYMENT_RECEIVED
        libera a etapa de fornecedor.
      */

      if (
        eventType !==
        "PAYMENT_RECEIVED"
      ) {
        return res.status(200).json({
          ok: true,
          ignored: true
        });
      }

      const externalReference =
        payment.externalReference;

      if (!externalReference) {
        console.warn(
          "Pagamento sem externalReference."
        );

        return res.status(200).json({
          ok: true
        });
      }

      const orderId =
        String(
          externalReference
        ).split("|")[0];

      const order =
        orders.get(orderId);

      if (!order) {
        console.warn(
          "Pedido VIBEZ não encontrado:",
          orderId
        );

        return res.status(200).json({
          ok: true
        });
      }

      /*
        Idempotência:
        nunca criaremos dois pedidos
        no fornecedor para o mesmo pedido.
      */

      if (
        order.supplierOrderId
      ) {
        console.log(
          "Pedido já enviado ao fornecedor:",
          order.supplierOrderId
        );

        return res.status(200).json({
          ok: true,
          alreadyProcessed: true
        });
      }

      order.paymentStatus =
        "RECEIVED";

      order.paidAt =
        new Date().toISOString();

      /*
        Por segurança, NÃO enviaremos
        automaticamente para FazerCards
        enquanto a categoria/oferta real
        não estiver configurada.
      */

      if (
        !process.env.FAZER_FREEFIRE_CATEGORY_ID ||
        !process.env.FAZER_FREEFIRE_OFFER_PREFIX
      ) {
        order.status =
          "paid_waiting_supplier_configuration";

        orders.set(
          orderId,
          order
        );

        console.log(
          "Pagamento recebido.",
          "Fornecedor ainda não configurado."
        );

        return res.status(200).json({
          ok: true,
          orderId,
          status:
            order.status
        });
      }

      /*
        Procura a oferta correspondente
        ao pacote.
      */

      const categoryId =
        process.env
          .FAZER_FREEFIRE_CATEGORY_ID;

      const offers =
        await fazerRequest(
          `/topups/offers?category_id=${encodeURIComponent(
            categoryId
          )}`
        );

      const offerList =
        Array.isArray(
          offers.offers
        )
          ? offers.offers
          : [];

      const expectedName =
        String(
          process.env
            .FAZER_FREEFIRE_OFFER_PREFIX
        ).toLowerCase();

      const supplierOffer =
        offerList.find(
          offer =>
            String(
              offer.name || ""
            )
              .toLowerCase()
              .includes(
                `${order.diamonds}`
              ) &&
            String(
              offer.name || ""
            )
              .toLowerCase()
              .includes(
                expectedName
              )
        );

      if (!supplierOffer) {
        order.status =
          "paid_supplier_offer_not_found";

        orders.set(
          orderId,
          order
        );

        console.error(
          "Oferta FazerCards não encontrada.",
          {
            diamonds:
              order.diamonds,
            categoryId
          }
        );

        return res.status(200).json({
          ok: true,
          orderId,
          status:
            order.status
        });
      }

      /*
        Pedido para FazerCards.
        Idempotency-Key impede duplicação.
      */

      const idempotencyKey =
        `vibez-${orderId}`;

      const supplierResult =
        await fazerRequest(
          "/topups/order",
          {
            method: "POST",

         
