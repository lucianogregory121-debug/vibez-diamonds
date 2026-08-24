require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.set("trust proxy", 1);
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

const FC_URL = (process.env.FAZERCARDS_API_URL || "https://api.fzr.cards/api/v2").replace(/\/$/, "");
const FC_KEY = process.env.FAZERCARDS_API_KEY || "";
const FC_CATEGORY = process.env.FAZERCARDS_CATEGORY_ID || "free_fire_br";
const USD_BRL = Number(process.env.USD_BRL_RATE || 5.5);
const MARKUP = Number(process.env.MARKUP_PERCENT || 30);

const ASAAS_URL = (process.env.ASAAS_API_URL || "https://api.asaas.com/v3").replace(/\/$/, "");
const ASAAS_KEY = process.env.ASAAS_API_KEY || "";
const WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN || "";
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");

const orders = new Map();
const processedEvents = new Set();
let catalog = { products: [], fields: [], loadedAt: 0 };

function configCheck() {
  const missing = [];
  if (!FC_KEY) missing.push("FAZERCARDS_API_KEY");
  if (!FC_CATEGORY) missing.push("FAZERCARDS_CATEGORY_ID");
  if (!Number.isFinite(USD_BRL) || USD_BRL <= 0) missing.push("USD_BRL_RATE");
  if (!Number.isFinite(MARKUP) || MARKUP < 0) missing.push("MARKUP_PERCENT");
  if (!ASAAS_KEY) missing.push("ASAAS_API_KEY");
  if (!APP_URL) missing.push("APP_URL");
  if (missing.length) throw new Error("Configuração ausente: " + missing.join(", "));
}

async function request(url, options = {}) {
  const r = await fetch(url, options);
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { raw: text }; }

  if (!r.ok) {
    const msg =
      data?.error ||
      data?.message ||
      data?.errors?.map?.(e => e.description || e.message || String(e)).join(" ") ||
      `HTTP ${r.status}`;
    throw new Error(msg);
  }

  return data;
}

async function fc(endpoint, options = {}) {
  if (!FC_KEY) throw new Error("FAZERCARDS_API_KEY não configurada.");

  return request(`${FC_URL}${endpoint}`, {
    ...options,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "X-Api-Key": FC_KEY,
      ...(options.headers || {})
    }
  });
}

async function asaas(endpoint, body) {
  if (!ASAAS_KEY) throw new Error("ASAAS_API_KEY não configurada.");

  return request(`${ASAAS_URL}${endpoint}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      access_token: ASAAS_KEY
    },
    body: JSON.stringify(body)
  });
}

function orderId() {
  return "VZ-" +
    Date.now().toString(36).toUpperCase() +
    "-" +
    crypto.randomBytes(3).toString("hex").toUpperCase();
}

function price(usd) {
  usd = Number(usd);
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new Error("Preço inválido recebido do FazerCards.");
  }
  return Number((usd * USD_BRL * (1 + MARKUP / 100)).toFixed(2));
}

async function loadProducts(force = false) {
  const now = Date.now();

  if (!force && catalog.products.length && now - catalog.loadedAt < 300000) {
    return catalog;
  }

  const data = await fc(
    `/topups/offers?category_id=${encodeURIComponent(FC_CATEGORY)}`,
    { method: "GET" }
  );

  if (data.ok === false) {
    throw new Error(data.error || "FazerCards não retornou as ofertas.");
  }

  const fields = Array.isArray(data.fields) ? data.fields : [];
  const offers = Array.isArray(data.offers) ? data.offers : [];

  const products = offers.map((offer, i) => {
    const usd = Number(offer.price_usd);
    const id = String(offer.offer_id || offer.id || "").trim();

    if (!id || !Number.isFinite(usd) || usd <= 0) return null;

    return {
      id,
      offerId: id,
      categoryId: FC_CATEGORY,
      type: "diamonds",
      name: offer.name || `Oferta ${i + 1}`,
      price: price(usd),
      supplierPriceUsd: usd,
      requires: "playerId"
    };
  }).filter(Boolean);

  catalog = { products, fields, loadedAt: now };
  console.log(`FazerCards: ${products.length} ofertas carregadas.`);
  return catalog;
}

function topupFields(playerId) {
  const fields = catalog.fields || [];
  if (!fields.length) {
    throw new Error("FazerCards não informou os campos necessários.");
  }

  const result = {};
  const accepted = [
    "player_id",
    "playerId",
    "uid",
    "user_id",
    "userId",
    "role_id",
    "roleId"
  ];

  for (const field of fields) {
    const key = String(field.key || "").trim();
    if (accepted.includes(key)) result[key] = playerId;
  }

  if (!Object.keys(result).length && fields.length === 1) {
    const key = String(fields[0].key || "").trim();
    if (key) result[key] = playerId;
  }

  if (!Object.keys(result).length) {
    throw new Error("Não consegui identificar o campo do Player ID.");
  }

  return result;
}

async function validatePlayer(playerId) {
  const data = await fc("/topups/validate-id", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      category_id: FC_CATEGORY,
      fields: topupFields(playerId)
    })
  });

  return {
    valid: data.valid !== false,
    playerName: data.player_name || null,
    region: data.region || null
  };
}

async function sendToFazerCards(order) {
  const data = await fc("/topups/order", {
    method: "POST",
    headers: { "Idempotency-Key": order.id },
    body: JSON.stringify({
      category_id: order.categoryId,
      offer_id: order.offerId,
      fields: topupFields(order.playerId)
    })
  });

  if (data.ok === false) {
    throw new Error(data.error || "FazerCards recusou o pedido.");
  }

  return data;
}

async function monitorOrder(id, supplierId) {
  for (let i = 0; i < 24; i++) {
    try {
      const data = await fc(
        `/orders/${encodeURIComponent(supplierId)}`,
        { method: "GET" }
      );

      const supplier = data.order || data;
      const status = String(supplier.status || "").toLowerCase();
      const current = orders.get(id);

      if (!current) return;

      if (["completed", "complete", "delivered"].includes(status)) {
        orders.set(id, {
          ...current,
          supplierStatus: supplier.status,
          supplierOrder: supplier,
          status: "completed",
          deliveryStatus: "delivered",
          completedAt: new Date().toISOString()
        });
        return;
      }

      if (["failed", "refunded", "cancelled"].includes(status)) {
        orders.set(id, {
          ...current,
          supplierStatus: supplier.status,
          supplierOrder: supplier,
          status,
          deliveryStatus: "failed"
        });
        return;
      }

      orders.set(id, {
        ...current,
        supplierStatus: supplier.status,
        supplierOrder: supplier
      });
    } catch (e) {
      console.error("Erro consultando FazerCards:", e.message);
    }

    await new Promise(r => setTimeout(r, 5000));
  }
}

async function deliver(order) {
  const current = orders.get(order.id);
  if (!current) return;

  if (
    current.supplierOrderId ||
    ["processing", "supplier_processing", "completed"].includes(current.status)
  ) {
    return;
  }

  orders.set(order.id, {
    ...current,
    status: "processing",
    deliveryStatus: "processing",
    paidAt: current.paidAt || new Date().toISOString()
  });

  try {
    const result = await sendToFazerCards(current);
    const supplier = result.order || result.data || result;

    const supplierId =
      result.order_id ||
      result.orderId ||
      supplier?.order_id ||
      supplier?.orderId ||
      supplier?.id ||
      result.id;

    if (!supplierId) {
      throw new Error("FazerCards não retornou o ID do pedido.");
    }

    orders.set(order.id, {
      ...orders.get(order.id),
      supplierOrderId: String(supplierId),
      supplierOrder: supplier,
      status: "supplier_processing",
      deliveryStatus: "supplier_processing",
      supplierCreatedAt: new Date().toISOString()
    });

    console.log("Pedido enviado ao FazerCards:", order.id, supplierId);

    monitorOrder(order.id, String(supplierId))
      .catch(e => console.error("Monitor:", e.message));

  } catch (e) {
    console.error("Erro enviando ao FazerCards:", e.message);

    orders.set(order.id, {
      ...orders.get(order.id),
      status: "supplier_error",
      deliveryStatus: "supplier_error",
      supplierError: e.message,
      supplierErrorAt: new Date().toISOString()
    });
  }
}

/* ========================= PRODUTOS ========================= */

app.get("/api/products", async (req, res) => {
  try {
    const data = await loadProducts();
    res.json({
      ok: true,
      categoryId: FC_CATEGORY,
      fields: data.fields,
      products: data.products
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/products/refresh", async (req, res) => {
  try {
    const data = await loadProducts(true);
    res.json({
      ok: true,
      products: data.products,
      fields: data.fields,
      count: data.products.length
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ========================= CONFIG ========================= */

app.get("/api/config", (req, res) => {
  res.json({
    ok: true,
    storeName: "VIBEZ DIAMONDS",
    supplier: "FazerCards",
    categoryId: FC_CATEGORY,
    supplierConfigured: Boolean(FC_KEY),
    paymentConfigured: Boolean(ASAAS_KEY),
    webhookConfigured: Boolean(WEBHOOK_TOKEN)
  });
});

/* ========================= CRIAR PEDIDO ========================= */

app.post("/api/orders", async (req, res) => {
  try {
    configCheck();

    const { productId, playerId } = req.body || {};
    const cleanPlayerId = String(playerId || "").trim();

    if (!/^\d{5,15}$/.test(cleanPlayerId)) {
      return res.status(400).json({
        ok: false,
        error: "Player ID inválido."
      });
    }

    const data = await loadProducts();

    const product = data.products.find(
      p => p.id === String(productId)
    );

    if (!product) {
      return res.status(400).json({
        ok: false,
        error: "Produto inválido ou indisponível."
      });
    }

    let validation;

    try {
      validation = await validatePlayer(cleanPlayerId);
    } catch (e) {
      return res.status(400).json({
        ok: false,
        error: "Não foi possível validar o Player ID: " + e.message
      });
    }

    if (validation.valid === false) {
      return res.status(400).json({
        ok: false,
        error: "Player ID inválido no FazerCards."
      });
    }

    const id = orderId();

    const order = {
      id,
      productId: product.id,
      offerId: product.offerId,
      categoryId: product.categoryId,
      productName: product.name,
      type: product.type,
      playerId: cleanPlayerId,
      playerName: validation.playerName,
      region: validation.region,
      supplierPriceUsd: product.supplierPriceUsd,
      price: product.price,
      status: "waiting_payment",
      deliveryStatus: "waiting_payment",
      createdAt: new Date().toISOString()
    };

    orders.set(id, order);

    const checkout = await asaas("/checkouts", {
      billingTypes: ["PIX", "CREDIT_CARD"],
      chargeTypes: ["DETACHED"],
      minutesToExpire: 60,
      externalReference: id,

      callback: {
        successUrl: `${APP_URL}/?payment=success&order=${encodeURIComponent(id)}`,
        cancelUrl: `${APP_URL}/?payment=cancelled&order=${encodeURIComponent(id)}`,
        expiredUrl: `${APP_URL}/?payment=expired&order=${encodeURIComponent(id)}`
      },

      items: [{
        externalReference: product.id,
        name: product.name,
        description: `Pedido VIBEZ DIAMONDS ${id}`,
        quantity: 1,
        value: product.price
      }]
    });

    const link =
      checkout.link ||
      (checkout.id
        ? `https://asaas.com/checkoutSession/show?id=${encodeURIComponent(checkout.id)}`
        : null);

    if (!link) {
      throw new Error("Asaas não retornou o link do checkout.");
    }

    orders.set(id, {
      ...order,
      checkoutId: checkout.id || null,
      checkoutLink: link,
      checkoutStatus: checkout.status || "ACTIVE"
    });

    res.json({
      ok: true,
      orderId: id,
      checkout: {
        id: checkout.id || null,
        link
      }
    });

  } catch (e) {
    console.error("Erro criando pedido:", e);
    res.status(500).json({
      ok: false,
      error: e.message || "Erro ao criar pagamento."
    });
  }
});

/* ========================= CONSULTAR PEDIDO ========================= */

app.get("/api/orders/:id", (req, res) => {
  const order = orders.get(req.params.id);

  if (!order) {
    return res.status(404).json({
      ok: false,
      error: "Pedido não encontrado."
    });
  }

  res.json({
    ok: true,
    order
  });
});

/* ========================= WEBHOOK ASAAS ========================= */

app.post("/api/webhooks/asaas", async (req, res) => {
  try {
    if (
      WEBHOOK_TOKEN &&
      req.headers["asaas-access-token"] !== WEBHOOK_TOKEN
    ) {
      return res.status(401).json({
        ok: false,
        error: "Webhook não autorizado."
      });
    }

    const event = req.body || {};
    const eventId =
      event.id ||
      `${event.event || "event"}:${event.payment?.id || Date.now()}`;

    if (processedEvents.has(eventId)) {
      return res.json({ ok: true, duplicate: true });
    }

    processedEvents.add(eventId);

    const payment = event.payment || {};
    const eventName = String(event.event || "").toUpperCase();

    const paidEvents = [
      "PAYMENT_CONFIRMED",
      "PAYMENT_RECEIVED"
    ];

    if (paidEvents.includes(eventName)) {
      const id =
        payment.externalReference ||
        payment.external_reference;

      if (id && orders.has(id)) {
        const order = orders.get(id);

        orders.set(id, {
          ...order,
          status: "paid",
          deliveryStatus: "paid",
          paymentId: payment.id || null,
          paidAt: new Date().toISOString()
        });

        await deliver(orders.get(id));
      }
    }

    return res.json({ ok: true });

  } catch (e) {
    console.error("Erro no webhook:", e);
    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});

/* ========================= HEALTH ========================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "VIBEZ DIAMONDS",
    time: new Date().toISOString()
  });
});

/* ========================= ERRO ========================= */

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({
    ok: false,
    error: "Erro interno do servidor."
  });
});

/* ========================= INICIAR ========================= */

app.listen(PORT, () => {
  console.log("=================================");
  console.log("VIBEZ DIAMONDS");
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`FazerCards: ${FC_KEY ? "CONFIGURADO" : "NÃO CONFIGURADO"}`);
  console.log(`Asaas: ${ASAAS_KEY ? "CONFIGURADO" : "NÃO CONFIGURADO"}`);
  console.log("=================================");
});
