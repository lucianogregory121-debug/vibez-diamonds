# VIBEZ DIAMONDS V2

Projeto inicial da loja com visual roxo/escuro.

## Arquivos
- `server.js` — servidor Node/Express e ponto de integração do fornecedor.
- `public/index.html` — interface da loja.
- `package.json` — dependências.
- `.env.example` — configuração do fornecedor sem expor chaves.

## Rodar
1. Instale Node.js 20+.
2. Execute `npm install`.
3. Copie `.env.example` para `.env`.
4. Preencha `SUPPLIER_API_URL` e `SUPPLIER_API_KEY` somente quando tiver um fornecedor autorizado.
5. Execute `npm start`.

## Importante
A integração automática do fornecedor não está fingida nesta V2. O endpoint `/api/orders`
cria o pedido em modo `pending_supplier`. A chamada real deve ser implementada usando
a documentação oficial do fornecedor contratado, mantendo a chave no servidor.
