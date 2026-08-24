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

const SUPPLIER_API_URL = (
  process.env.SUPPLIER_API_URL || ""
).replace(/\/$/, "");

const SUPPLIER_USER_ID =
  process.env.SUPPLIER_USER_ID || "";

const SUPPLIER_API_KEY =
  process.env.SUPPLIER_API_KEY || "";

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
   PRODUTOS
===================================================== */

const products = [
  {
    id: "d200",
    type: "diamonds",
    name: "200 Diamantes",
    amount: 200,
    price: 10.90,
    requires: "accessToken"
  },
  {
    id: "d620",
    type: "diamonds",
    name: "620 Diamantes",
    amount: 620,
    price: 24.90,
    requires: "accessToken"
  },
  {
    id: "d1040",
    type: "diamonds",
    name: "1.040 Diamantes",
    amount: 1040,
    price: 34.90,
    requires: "accessToken"
  },
  {
    id: "d2120",
    type: "diamonds",
    name: "2.120 Diamantes",
    amount: 2120,
    price: 64.90,
    requires: "accessToken"
  },
  {
    id: "d4360",
    type: "diamonds",
    name: "4.360 Diamantes",
    amount: 4360,
    price: 119.90,
    requires: "accessToken"
  },
  {
    id: "d5300",
    type: "diamonds",
    name: "5.300 Diamantes",
    amount: 5300,
    price: 139.90,
    requires: "accessToken"
  },
  {
    id: "token",
    type: "token",
    name: "Token",
    quantity: 1,
    price: 4.90,
    requires: "playerId"
  },
  {
    id: "pass",
    type: "pass",
    name: "Passe Booyah",
    price: 6.90,
    requires: "playerId"
  }
];


/* =====================================================
   PEDIDOS
===================================================== */

/*
  IMPORTANTE:
  Este armazenamento é temporário.
  Para produção, depois vamos colocar PostgreSQL
  para os pedidos não desaparecerem quando o Render
  reiniciar o serviço.
*/

const orders = new Map();

const processedEvents = new Set();


/* =====================================================
   CONFIGURAÇÃO
===================================================== */

function checkConfig() {

  const missing = [];

  if (!SUPPLIER_API_URL)
    missing.push("SUPPLIER_API_URL");

  if (!SUPPLIER_USER_ID)
    missing.push("SUPPLIER_USER_ID");

  if (!SUPPLIER_API_KEY)
    missing.push("SUPPLIER_API_KEY");

  if (!ASAAS_API_KEY)
    missing.push("ASAAS_API_KEY");

  if (!APP_URL)
    missing.push("APP_URL");

  if (missing.length) {

    throw new Error(
      "Variáveis ausentes no Render: " +
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
      data?.errors
        ?.map?.(
          error =>
            error.description
        )
        .join(" ") ||

      data?.message ||

      data?.error ||

      `HTTP ${response.status}`;

    throw new Error(message);

  }

  return data;

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
   FREE FIRE SHOP
===================================================== */

async function supplierRequest(
  endpoint,
  body
) {

  checkConfig();

  return requestJson(
    `${SUPPLIER_API_URL}${endpoint}`,
    {

      method: "POST",

      headers: {

        accept:
          "application/json",

        "content-type":
          "application/json"

      },

      body:
        JSON.stringify({

          userId:
            SUPPLIER_USER_ID,

          key:
            SUPPLIER_API_KEY,

          ...body

        })

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
   PRODUTOS
===================================================== */

app.get(
  "/api/products",
  (req, res) => {

    res.json({

      ok: true,

      products

    });

  }
);


/* =====================================================
   CONFIGURAÇÃO DO SITE
===================================================== */

app.get(
  "/api/config",
  (req, res) => {

    res.json({

      ok: true,

      storeName:
        "VIBEZ DIAMONDS",

      supplierConfigured:
        Boolean(
          SUPPLIER_API_URL &&
          SUPPLIER_USER_ID &&
          SUPPLIER_API_KEY
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
        playerId,
        accessToken
      } = req.body || {};

      const product =
        products.find(
          item =>
            item.id ===
            productId
        );


      if (!product) {

        return res.status(400).json({

          ok: false,

          error:
            "Produto inválido."

        });

      }


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


      if (
        product.requires ===
        "accessToken" &&
        !String(
          accessToken || ""
        ).trim()
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "Informe o accessToken."

        });

      }


      const orderId =
        createOrderId();


      const order = {

        id:
          orderId,

        productId:
          product.id,

        productName:
          product.name,

        type:
          product.type,

        amount:
          product.amount || null,

        quantity:
          product.quantity || null,

        playerId:
          cleanPlayerId,

        /*
          O token fica somente no servidor.
          Nunca enviamos esse campo ao navegador.
        */

        accessToken:
          product.requires ===
          "accessToken"
            ? String(accessToken)
            : null,

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
                  `Pedido VIBEZ ${orderId}`,

                quantity: 1,

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


    /*
      Nunca devolvemos o accessToken
      para o navegador.
    */

    const safeOrder = {
      ...order
    };

    delete safeOrder.accessToken;


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
  "/api/webhooks/asaas",
  async (req, res) => {

    try {

      const event =
        String(
          req.body?.event || ""
        ).toUpperCase();


      const payment =
        req.body?.payment || {};


      const externalReference =
        payment.externalReference ||
        req.body?.checkout?.externalReference;


      if (!externalReference) {

        return res.status(200).json({
          received: true
        });

      }


      const eventKey =
        `${event}:${payment.id || externalReference}`;


      if (
        processedEvents.has(
          eventKey
        )
      ) {

        return res.status(200).json({
          received: true
        });

      }


      processedEvents.add(
        eventKey
      );


      const order =
        orders.get(
          externalReference
        );


      if (!order) {

        console.log(
          "Pedido não encontrado:",
          externalReference
        );

        return res.status(200).json({
          received: true
        });

      }


      /* =================================================
         PAGAMENTO RECEBIDO
      ================================================= */

      if (
        event ===
          "PAYMENT_RECEIVED" ||
        event ===
          "PAYMENT_CONFIRMED"
      ) {

        const paidOrder = {

          ...order,

          status:
            "paid",

          paymentId:
            payment.id || null,

          paidAt:
            new Date().toISOString(),

          deliveryStatus:
            "processing"

        };


        orders.set(
          order.id,
          paidOrder
        );


        /*
          ATENÇÃO:
          Aqui está a chamada ao fornecedor.

          NÃO vamos inventar os parâmetros da API.
          Quando você me passar a tela/documentação
          exata do endpoint escolhido, ajustamos estas
          funções para os parâmetros oficiais.
        */

        try {

          let result;


          if (
            order.type ===
            "diamonds"
          ) {

            result =
              await supplierRequest(
                "/api/v1/diamonds/send",
                {

                  accessToken:
                    order.accessToken,

                  diamondAmount:
                    order.amount

                }
              );

          }


          else if (
            order.type ===
            "token"
          ) {

            result =
              await supplierRequest(
                "/api/v1/tokens/send",
                {

                  playerID:
                    order.playerId,

                  quantity:
                    order.quantity || 1,

                  mensagem:
                    `Pedido ${order.id}`

                }
              );

          }


          else if (
            order.type ===
            "pass"
          ) {

            result =
              await supplierRequest(
                "/api/v1/pass/send",
                {

                  uid:
                    order.playerId

                }
              );

          }


          orders.set(
            order.id,
            {

              ...paidOrder,

              deliveryStatus:
                "delivered",

              supplierResponse:
                result,

              deliveredAt:
                new Date().toISOString()

            }
          );


          console.log(
            "Entrega concluída:",
            order.id
          );


        } catch (deliveryError) {

          console.error(
            "Erro na entrega:",
            deliveryError
          );


          orders.set(
            order.id,
            {

              ...paidOrder,

              deliveryStatus:
                "failed",

              deliveryError:
                deliveryError.message

            }
          );

        }

      }


      /* =================================================
         PAGAMENTO CANCELADO
      ================================================= */

      if (
        event ===
        "PAYMENT_DELETED"
      ) {

        orders.set(
          order.id,
          {

            ...order,

            status:
              "cancelled",

            deliveryStatus:
              "cancelled"

          }
        );

      }


      res.status(200).json({

        received:
          true

      });


    } catch (error) {

      console.error(
        "Erro no webhook:",
        error
      );

      res.status(500).json({

        received:
          false

      });

    }

  }
);


/* =====================================================
   HEALTH CHECK
===================================================== */

app.get(
  "/health",
  (req, res) => {

    res.json({

      ok: true,

      service:
        "VIBEZ DIAMONDS",

      supplier:
        Boolean(
          SUPPLIER_API_URL &&
          SUPPLIER_USER_ID &&
          SUPPLIER_API_KEY
        ),

      asaas:
        Boolean(
          ASAAS_API_KEY
        )

    });

  }
);


/* =====================================================
   FALLBACK PARA INDEX.HTML
===================================================== */

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


/* =====================================================
   404
===================================================== */

app.use(
  (req, res) => {

    res.status(404).json({

      ok: false,

      error:
        "Página não encontrada."

    });

  }
);


/* =====================================================
   SERVIDOR
===================================================== */

app.listen(
  PORT,
  () => {

    console.log(
      "===================================="
    );

    console.log(
      `VIBEZ DIAMONDS rodando na porta ${PORT}`
    );

    console.log(
      `Fornecedor configurado: ${
        Boolean(
          SUPPLIER_API_URL &&
          SUPPLIER_USER_ID &&
          SUPPLIER_API_KEY
        )
      }`
    );

    console.log(
      `Asaas configurado: ${
        Boolean(
          ASAAS_API_KEY
        )
      }`
    );

    console.log(
      "===================================="
    );

  }
);
