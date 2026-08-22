require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

const products = [
  { id: "d100", diamonds: 100, price: 4.99 },
  { id: "d310", diamonds: 310, price: 12.99 },
  { id: "d520", diamonds: 520, price: 19.99 },
  { id: "d1060", diamonds: 1060, price: 39.99 },
  { id: "d2180", diamonds: 2180, price: 79.99 },
  { id: "d5600", diamonds: 5600, price: 199.99 }
];

app.get("/api/config", (_, res) => {
  res.json({
    storeName: process.env.STORE_NAME || "VIBEZ DIAMONDS",
    supplierConfigured: Boolean(process.env.SUPPLIER_API_URL && process.env.SUPPLIER_API_KEY)
  });
});

app.get("/api/products", (_, res) => {
  res.json({ products });
});

/*
  Ponto de integração do fornecedor.
  Por segurança, a chave fica somente no servidor.
  Quando você tiver um fornecedor autorizado, implemente a chamada
  aqui conforme a documentação oficial dele.
*/
app.post("/api/orders", async (req, res) => {
  try {
    const { playerId, productId, paymentMethod } = req.body;

    if (!playerId || !productId || !paymentMethod) {
      return res.status(400).json({ error: "Preencha todos os dados." });
    }

    const product = products.find(p => p.id === productId);
    if (!product) {
      return res.status(400).json({ error: "Produto inválido." });
    }

    const orderId = "VZ-" + Date.now().toString(36).toUpperCase();

    // Nesta V2 o pedido fica em modo seguro/demonstração.
    // A entrega automática só deve ser ativada depois da integração
    // com um fornecedor legítimo e de acordo com os termos aplicáveis.
    res.json({
      ok: true,
      order: {
        id: orderId,
        playerId: String(playerId).trim(),
        productId: product.id,
        diamonds: product.diamonds,
        price: product.price,
        paymentMethod,
        status: "pending_supplier"
      },
      supplierConfigured: Boolean(process.env.SUPPLIER_API_URL && process.env.SUPPLIER_API_KEY)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao criar pedido." });
  }
});

app.get("*", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`VIBEZ DIAMONDS rodando na porta ${PORT}`);
});
