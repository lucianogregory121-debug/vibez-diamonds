require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 3000;

/* =========================================================
   CONFIGURAÇÕES
========================================================= */

const ASAAS_API_URL =
  process.env.ASAAS_API_URL ||
  "https://api.asaas.com/v3";

const FAZER_API_URL =
  process.env.FAZER_API_URL ||
  "https://api.fzr.cards/api/v2";

const STORE_NAME =
  process.env.STORE_NAME ||
  "VIBEZ DIAMONDS";

/*
  IMPORTANTE:
  Coloque no Render a cotação USD -> BRL que você
  deseja usar para transformar o preço da FazerCards
  em preço de venda no Asaas.

  Exemplo:
  FAZER_USD_BRL_RATE=5.50

  NÃO coloque o símbolo R$.
*/

const USD_BRL_RATE = Number(
  process.env.FAZER_USD_BRL_RATE || 0
);

/*
  Margem da loja.

  Exemplo:
  30 = acrescenta 30%
  50 = acrescenta 50%
*/

const STORE_MARKUP_PERCENT = Number(
  process.env.STORE_MARKUP_PERCENT || 0
);

/*
  ID da categoria Free Fire LATAM.

  Se deixar vazio, o servidor tenta encontrar
  automaticamente uma categoria cujo nome contenha
  "Free Fire" e "LATAM".
*/

const FREE_FIRE_CATEGORY_ID =
  process.env.FAZER_FREEFIRE_CATEGORY_ID ||
  "";

/*
  Campo padrão para o Player ID.

  O servidor também consulta os campos reais
  retornados pela FazerCards.
*/

const DEFAULT_PLAYER_FIELD =
  process.env.FAZER_PLAYER_FIELD ||
  "player_id";

/* =========================================================
   POSTGRESQL
========================================================= */

let pool = null;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString:
      process.env.DATABASE_URL,

    ssl:
      process.env.DATABASE_URL.includes(
        "localhost"
      )
        ? false
        : {
            rejectUnauthorized: false
          }
  });

  pool.on(
    "error",
    (error) => {
      console.error(
        "Erro no PostgreSQL:",
        error
      );
    }
  );
}

/*
  Fallback em memória.

  Funciona para testes, mas para produção o ideal
  é usar DATABASE_URL.
*/

const memoryOrders = new Map();
const memoryWebhookEvents = new Set();

/* =========================================================
   EXPRESS
========================================================= */

app.set(
  "trust proxy",
  1
);

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

/*
  Webhook FazerCards precisa do corpo RAW
  para validar a assinatura.

  Por isso esta rota fica ANTES do express.json().
*/

app.post(
  "/api/webhooks/fazercards",
  express.raw({
    type: "application/json"
  }),
  async (req, res) => {
    try {
      const secret =
        process.env.FAZER_WEBHOOK_SECRET;

      if (!secret) {
        console.error(
          "FAZER_WEBHOOK_SECRET não configurado."
        );

        return res
          .status(500)
          .send("Webhook não configurado.");
      }

      const signature =
        req.get(
          "X-FazerCards-Signature"
        ) || "";

      const rawBody =
        Buffer.isBuffer(req.body)
          ? req.body
          : Buffer.from(
              String(req.body || "")
            );

      const expected =
        crypto
          .createHmac(
            "sha256",
            secret
          )
          .update(rawBody)
          .digest("hex");

      /*
        Algumas versões/documentações usam
        sha256=<hex>.

        Aceitamos os dois formatos.
      */

      const received =
        signature.startsWith(
          "sha256="
        )
          ? signature.substring(7)
          : signature;

      if (
        received.length !==
        expected.length
      ) {
        return res
          .status(401)
          .send(
            "Assinatura inválida."
          );
      }

      const valid =
        crypto.timingSafeEqual(
          Buffer.from(received),
          Buffer.from(expected)
        );

      if (!valid) {
        return res
          .status(401)
          .send(
            "Assinatura inválida."
          );
      }

      const event =
        JSON.parse(
          rawBody.toString("utf8")
        );

      console.log(
        "Webhook FazerCards:",
        JSON.stringify(
          event,
          null,
          2
        )
      );

      /*
        Estrutura atual documentada pela FazerCards:

        {
          event: "order.status_changed",
          event_id: "...",
          data: {
            order_id: "...",
            status: "completed"
          }
        }
      */

      const eventId =
        event.event_id ||
        event.id ||
        crypto.randomUUID();

      const alreadyProcessed =
        await webhookAlreadyProcessed(
          "fazercards",
          eventId
        );

      if (alreadyProcessed) {
        return res
          .status(200)
          .send("OK");
      }

      await saveWebhookEvent(
        "fazercards",
        eventId
      );

      const supplierOrderId =
        event?.data?.order_id ||
        event?.order?.id;

      const supplierStatus =
        String(
          event?.data?.status ||
          event?.order?.status ||
          ""
        ).toLowerCase();

      if (supplierOrderId) {
        const order =
          await findOrderBySupplierOrderId(
            supplierOrderId
          );

        if (order) {
          let newStatus =
            order.status;

          if (
            supplierStatus ===
              "completed" ||
            supplierStatus ===
              "complete"
          ) {
            newStatus =
              "delivered";
          }

          else if (
            supplierStatus ===
              "failed"
          ) {
            newStatus =
              "delivery_failed";
          }

          else if (
            supplierStatus ===
              "refunded"
          ) {
            newStatus =
              "refunded";
          }

          else if (
            supplierStatus
          ) {
            newStatus =
              "supplier_processing";
          }

          await updateOrder(
            order.id,
            {
              status:
                newStatus,

              supplierStatus:
                supplierStatus
            }
          );
        }
      }

      return res
        .status(200)
        .send("OK");

    } catch (error) {
      console.error(
        "Erro no webhook FazerCards:",
        error
      );

      /*
        Respondemos 200 apenas quando conseguimos
        validar/processar a requisição.

        Em erro real, 500 permite que o fornecedor
        tente novamente.
      */

      return res
        .status(500)
        .send("Erro interno.");
    }
  }
);

app.use(
  express.json({
    limit: "1mb"
  })
);

/* =========================================================
   BANCO
========================================================= */

async function initDatabase() {
  if (!pool) {
    console.warn(
      "DATABASE_URL não configurada."
    );

    console.warn(
      "O sistema funcionará em memória."
    );

    console.warn(
      "Configure PostgreSQL no Render para produção."
    );

    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,

      player_id TEXT NOT NULL,

      category_id TEXT NOT NULL,

      offer_id TEXT NOT NULL,

      product_name TEXT NOT NULL,

      price_usd NUMERIC(12,4),

      price_brl NUMERIC(12,2),

      payment_method TEXT NOT NULL,

      status TEXT NOT NULL,

      asaas_checkout_id TEXT,

      asaas_external_reference TEXT,

      supplier_order_id TEXT,

      supplier_status TEXT,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_orders_asaas_checkout
    ON orders(asaas_checkout_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_orders_supplier
    ON orders(supplier_order_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_orders_reference
    ON orders(asaas_external_reference);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      provider TEXT NOT NULL,

      event_id TEXT NOT NULL,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      PRIMARY KEY(provider, event_id)
    );
  `);

  console.log(
    "PostgreSQL inicializado."
  );
}

/* =========================================================
   FUNÇÕES DE PEDIDOS
========================================================= */

async function saveOrder(order) {
  if (!pool) {
    memoryOrders.set(
      order.id,
      {
        ...order
      }
    );

    return order;
  }

  await pool.query(
    `
    INSERT INTO orders (
      id,
      player_id,
      category_id,
      offer_id,
      product_name,
      price_usd,
      price_brl,
      payment_method,
      status,
      asaas_checkout_id,
      asaas_external_reference,
      supplier_order_id,
      supplier_status
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,
      $10,$11,$12,$13
    )
    ON CONFLICT (id)
    DO UPDATE SET
      player_id =
        EXCLUDED.player_id,

      category_id =
        EXCLUDED.category_id,

      offer_id =
        EXCLUDED.offer_id,

      product_name =
        EXCLUDED.product_name,

      price_usd =
        EXCLUDED.price_usd,

      price_brl =
        EXCLUDED.price_brl,

      payment_method =
        EXCLUDED.payment_method,

      status =
        EXCLUDED.status,

      asaas_checkout_id =
        EXCLUDED.asaas_checkout_id,

      asaas_external_reference =
        EXCLUDED.asaas_external_reference,

      supplier_order_id =
        EXCLUDED.supplier_order_id,

      supplier_status =
        EXCLUDED.supplier_status,

      updated_at =
        NOW()
    `,
    [
      order.id,
      order.playerId,
      order.categoryId,
      order.offerId,
      order.productName,
      order.priceUsd,
      order.priceBrl,
      order.paymentMethod,
      order.status,
      order.asaasCheckoutId || null,
      order.asaasExternalReference || null,
      order.supplierOrderId || null,
      order.supplierStatus || null
    ]
  );

  return order;
}

async function getOrder(orderId) {
  if (!pool) {
    return (
      memoryOrders.get(
        orderId
      ) || null
    );
  }

  const result =
    await pool.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1
      LIMIT 1
      `,
      [orderId]
    );

  if (!result.rows[0]) {
    return null;
  }

  return rowToOrder(
    result.rows[0]
  );
}

async function updateOrder(
  orderId,
  changes
) {
  const order =
    await getOrder(orderId);

  if (!order) {
    return null;
  }

  const updated = {
    ...order,
    ...changes,
    updatedAt:
      new Date().toISOString()
  };

  if (!pool) {
    memoryOrders.set(
      orderId,
      updated
    );

    return updated;
  }

  await pool.query(
    `
    UPDATE orders
    SET
      status = $2,
      asaas_checkout_id = $3,
      asaas_external_reference = $4,
      supplier_order_id = $5,
      supplier_status = $6,
      updated_at = NOW()
    WHERE id = $1
    `,
    [
      orderId,
      updated.status,
      updated.asaasCheckoutId ||
        null,
      updated.asaasExternalReference ||
        null,
      updated.supplierOrderId ||
        null,
      updated.supplierStatus ||
        null
    ]
  );

  return updated;
}

async function findOrderByCheckoutId(
  checkoutId
) {
  if (!checkoutId) {
    return null;
  }

  if (!pool) {
    for (
      const order of memoryOrders.values()
    ) {
      if (
        order.asaasCheckoutId ===
        checkoutId
      ) {
        return order;
      }
    }

    return null;
  }

  const result =
    await pool.query(
      `
      SELECT *
      FROM orders
      WHERE asaas_checkout_id = $1
      LIMIT 1
      `,
      [checkoutId]
    );

  return result.rows[0]
    ? rowToOrder(
        result.rows[0]
      )
    : null;
}

async function findOrderByReference(
  reference
) {
  if (!reference) {
    return null;
  }

  if (!pool) {
    for (
      const order of memoryOrders.values()
    ) {
      if (
        order.asaasExternalReference ===
        reference
      ) {
        return order;
      }
    }

    return null;
  }

  const result =
    await pool.query(
      `
      SELECT *
      FROM orders
      WHERE asaas_external_reference = $1
      LIMIT 1
      `,
      [reference]
    );

  return result.rows[0]
    ? rowToOrder(
        result.rows[0]
      )
    : null;
}

async function findOrderBySupplierOrderId(
  supplierOrderId
) {
  if (!supplierOrderId) {
    return null;
  }

  if (!pool) {
    for (
      const order of memoryOrders.values()
    ) {
      if (
        order.supplierOrderId ===
        supplierOrderId
      ) {
        return order;
      }
    }

    return null;
  }

  const result =
    await pool.query(
      `
      SELECT *
      FROM orders
      WHERE supplier_order_id = $1
      LIMIT 1
      `,
      [supplierOrderId]
    );

  return result.rows[0]
    ? rowToOrder(
        result.rows[0]
      )
    : null;
}

function rowToOrder(row) {
  return {
    id:
      row.id,

    playerId:
      row.player_id,

    categoryId:
      row.category_id,

    offerId:
      row.offer_id,

    productName:
      row.product_name,

    priceUsd:
      Number(
        row.price_usd
      ),

    priceBrl:
      Number(
        row.price_brl
      ),

    paymentMethod:
      row.payment_method,

    status:
      row.status,

    asaasCheckoutId:
      row.asaas_checkout_id,

    asaasExternalReference:
      row.asaas_external_reference,

    supplierOrderId:
      row.supplier_order_id,

    supplierStatus:
      row.supplier_status,

    createdAt:
      row.created_at,

    updatedAt:
      row.updated_at
  };
}

/* =========================================================
   WEBHOOK IDEMPOTÊNCIA
========================================================= */

async function webhookAlreadyProcessed(
  provider,
  eventId
) {
  if (!pool) {
    return memoryWebhookEvents.has(
      `${provider}:${eventId}`
    );
  }

  const result =
    await pool.query(
      `
      SELECT 1
      FROM webhook_events
      WHERE provider = $1
      AND event_id = $2
      LIMIT 1
      `,
      [
        provider,
        eventId
      ]
    );

  return result.rowCount > 0;
}

async function saveWebhookEvent(
  provider,
  eventId
) {
  if (!pool) {
    memoryWebhookEvents.add(
      `${provider}:${eventId}`
    );

    return;
  }

  await pool.query(
    `
    INSERT INTO webhook_events (
      provider,
      event_id
    )
    VALUES ($1,$2)
    ON CONFLICT DO NOTHING
    `,
    [
      provider,
      eventId
    ]
  );
}

/* =========================================================
   ASAAS
========================================================= */

function asaasConfigured() {
  return Boolean(
    process.env.ASAAS_API_KEY
  );
}

function getBaseUrl(req) {
  const url =
    process.env.PUBLIC_URL ||
    `${req.protocol}://${req.get(
      "host"
    )}`;

  return url.replace(
    /\/$/,
    ""
  );
}

async function asaasRequest(
  endpoint,
  options = {}
) {
  if (!asaasConfigured()) {
    throw new Error(
      "ASAAS_API_KEY não configurada."
    );
  }

  const response =
    await fetch(
      `${ASAAS_API_URL}${endpoint}`,
      {
        ...options,

        headers: {
          accept:
            "application/json",

          "content-type":
            "application/json",

          access_token:
            process.env
              .ASAAS_API_KEY,

          ...(options.headers ||
            {})
        }
      }
    );

  const text =
    await response.text();

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
      "Erro Asaas:",
      response.status,
      data
    );

    const message =
      data?.errors
        ?.map?.(
          (error) =>
            error.description
        )
        .join(" ") ||
      data?.message ||
      "Erro na API Asaas.";

    throw new Error(
      message
    );
  }

  return data;
}

/* =========================================================
   FAZERCARDS
========================================================= */

function fazerConfigured() {
  return Boolean(
    process.env.FAZER_API_KEY
  );
}

async function fazerRequest(
  endpoint,
  options = {}
) {
  if (!fazerConfigured()) {
    throw new Error(
      "FAZER_API_KEY não configurada."
    );
  }

  const response =
    await fetch(
      `${FAZER_API_URL}${endpoint}`,
      {
        ...options,

        headers: {
          accept:
            "application/json",

          "content-type":
            "application/json",

          "X-API-Key":
            process.env.FAZER_API_KEY,

          ...(options.headers ||
            {})
        }
      }
    );

  const text =
    await response.text();

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
      "Erro FazerCards:",
      response.status,
      data
    );

    throw new Error(
      data?.error ||
        data?.message ||
        "Erro na API FazerCards."
    );
  }

  if (
    data &&
    data.ok === false
  ) {
    throw new Error(
      data.error ||
        "FazerCards retornou erro."
    );
  }

  return data;
}

/* =========================================================
   CACHE FAZERCARDS
========================================================= */

let freeFireCache = {
  category: null,
  offers: null,
  fields: [],
  expiresAt: 0
};

async function getFreeFireCategory() {
  if (
    FREE_FIRE_CATEGORY_ID
  ) {
    return {
      category_id:
        FREE_FIRE_CATEGORY_ID,
      name:
        "Free Fire (LATAM)"
    };
  }

  const categories =
    await fazerRequest(
      "/topups?limit=50"
    );

  let items =
    Array.isArray(
      categories.items
    )
      ? [
          ...categories.items
        ]
      : [];

  let cursor =
    categories?.meta
      ?.next_cursor ||
    null;

  let attempts = 0;

  while (
    cursor &&
    attempts < 10
  ) {
    const page =
      await fazerRequest(
        `/topups?limit=50&cursor=${encodeURIComponent(
          cursor
        )}`
      );

    if (
      Array.isArray(
        page.items
      )
    ) {
      items.push(
        ...page.items
      );
    }

    cursor =
      page?.meta
        ?.next_cursor ||
      null;

    attempts++;
  }

  const exact =
    items.find(
      (item) =>
        /free\s*fire/i.test(
          String(
            item.name || ""
          )
        ) &&
        /latam/i.test(
          String(
            item.name || ""
          )
        )
    );

  if (exact) {
    return exact;
  }

  const freeFire =
    items.find(
      (item) =>
        /free\s*fire/i.test(
          String(
            item.name || ""
          )
        )
    );

  if (freeFire) {
    return freeFire;
  }

  throw new Error(
    "Não encontrei Free Fire LATAM no catálogo da FazerCards."
  );
}

async function getFreeFireOffers(
  force = false
) {
  if (
    !force &&
    freeFireCache.expiresAt >
      Date.now() &&
    freeFireCache.offers
  ) {
    return freeFireCache;
  }

  const category =
    await getFreeFireCategory();

  const result =
    await fazerRequest(
      `/topups/offers?category_id=${encodeURIComponent(
        category.category_id
      )}`
    );

  freeFireCache = {
    category,

    offers:
      Array.isArray(
        result.offers
      )
        ? result.offers
        : [],

    fields:
      Array.isArray(
        result.fields
      )
        ? result.fields
        : [],

    expiresAt:
      Date.now() +
      30 *
