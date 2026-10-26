require("dotenv").config();
const { Pool } = require("pg");

const apiUrl = process.env.API_URL || "http://127.0.0.1:3333";
const testEmail = `teste-tcc-${Date.now()}@example.com`;
let productId = null;

async function request(path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${data.error || response.status}`);
  return data;
}

async function cleanup() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM "ItemPedido" WHERE "pedidoId" IN (
        SELECT id FROM "Pedido" WHERE "clienteId" IN (
          SELECT id FROM "Cliente" WHERE email = $1
        )
      )`,
      [testEmail],
    );
    await client.query(
      `DELETE FROM "Pedido" WHERE "clienteId" IN (
        SELECT id FROM "Cliente" WHERE email = $1
      )`,
      [testEmail],
    );
    await client.query(
      `DELETE FROM "ListaPresenteProduto" WHERE "listaId" IN (
        SELECT id FROM "ListaPresente" WHERE "clienteId" IN (
          SELECT id FROM "Cliente" WHERE email = $1
        )
      )`,
      [testEmail],
    );
    await client.query(
      `DELETE FROM "ListaPresente" WHERE "clienteId" IN (
        SELECT id FROM "Cliente" WHERE email = $1
      )`,
      [testEmail],
    );
    await client.query(`DELETE FROM "RecuperacaoSenha" WHERE email = $1`, [testEmail]);
    await client.query(`DELETE FROM "Cliente" WHERE email = $1`, [testEmail]);
    if (productId) await client.query(`DELETE FROM "Produto" WHERE id = $1`, [productId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  try {
    const admin = await request("/auth/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: process.env.ADMIN_EMAIL || "admin@pegadakids.com.br",
        senha: process.env.ADMIN_PASSWORD || "fema2026",
      }),
    });

    const form = new FormData();
    form.set("nome", "Produto temporário do teste");
    form.set("preco", "10.00");
    form.set("quantidadeEstoque", "7");
    form.set("categoria", "exclusivas");
    form.set("tamanhos", "P, M, G");
    form.set(
      "estoquesPorTamanho",
      JSON.stringify([
        { tamanho: "P", quantidade: 2 },
        { tamanho: "M", quantidade: 4 },
        { tamanho: "G", quantidade: 1 },
      ]),
    );
    const productResult = await request("/produtos", {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}` },
      body: form,
    });
    productId = productResult.produto.id;

    const registration = await request("/clientes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nome: "Cliente Temporário",
        email: testEmail,
        senha: "Teste@123",
        cpf: "52998224725",
      }),
    });

    const recovery = await request("/auth/recuperar-senha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: testEmail, perfil: "CLIENTE" }),
    });
    if (!recovery.resetUrl) {
      throw new Error("O link local de recuperação de senha não foi gerado.");
    }
    const resetToken = new URL(recovery.resetUrl).searchParams.get("token");
    if (!resetToken) throw new Error("O token de recuperação não foi informado.");
    await request("/auth/redefinir-senha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: resetToken, novaSenha: "NovaSenha@123" }),
    });
    const recoveredLogin = await request("/auth/clientes/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: testEmail, senha: "NovaSenha@123" }),
    });
    const clientHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${recoveredLogin.token}`,
    };
    const adminHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${admin.token}`,
    };

    const cep = await request("/enderecos/cep/01310100", { headers: clientHeaders });
    if (cep.cidade !== "São Paulo" || cep.estado !== "SP") {
      throw new Error("A consulta do CEP não retornou o endereço esperado.");
    }
    const addressUpdate = await request("/clientes/me/endereco", {
      method: "PATCH",
      headers: clientHeaders,
      body: JSON.stringify({
        cep: cep.cep,
        rua: cep.rua || "Avenida Paulista",
        numero: "1000",
        bairro: cep.bairro || "Bela Vista",
        cidade: cep.cidade,
        estado: cep.estado,
      }),
    });
    const currentClient = await request("/clientes/me", { headers: clientHeaders });
    if (addressUpdate.cliente.cep !== "01310100" || currentClient.numero !== "1000") {
      throw new Error("O endereço atualizado não foi recuperado na conta do cliente.");
    }

    const adminClients = await request("/admin/clientes", { headers: adminHeaders });
    if (!adminClients.some((client) => client.id === registration.cliente.id)) {
      throw new Error("O cliente não apareceu no painel administrativo.");
    }
    await request(`/admin/clientes/${registration.cliente.id}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({
        ...registration.cliente,
        cidade: "Paraguaçu Paulista",
        estado: "SP",
      }),
    });

    const list = await request("/listas", {
      method: "POST",
      headers: clientHeaders,
      body: JSON.stringify({ nomeBebe: "Bebê Teste", dataEvento: "2026-12-20", tema: "MENINO" }),
    });
    const adminLists = await request("/admin/listas", { headers: adminHeaders });
    if (!adminLists.some((adminList) => adminList.id === list.id)) {
      throw new Error("A lista não apareceu na central administrativa.");
    }
    await request(`/admin/listas/${list.id}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ nomeBebe: "Bebê Teste Atualizado", dataEvento: "2026-12-21", tema: "MENINO" }),
    });
    await request(`/listas/${list.id}/produtos`, {
      method: "POST",
      headers: clientHeaders,
      body: JSON.stringify({ produtoId: productId, tamanho: "M" }),
    });

    const order = await request("/pedidos/whatsapp", {
      method: "POST",
      headers: clientHeaders,
      body: JSON.stringify({
        itensCarrinho: [{ id: productId, quantidade: 1, listaPresenteId: list.id }],
        entrega: {
          tipoEntrega: "ENTREGA",
          cep: currentClient.cep,
          rua: currentClient.rua,
          numero: currentClient.numero,
          bairro: currentClient.bairro,
          cidade: currentClient.cidade,
          estado: currentClient.estado,
        },
      }),
    });
    const firstConfirmation = await request(`/pedidos/${order.pedidoId}/simular-pagamento`, {
      method: "POST",
      headers: { Authorization: `Bearer ${registration.token}` },
    });
    const secondConfirmation = await request(`/pedidos/${order.pedidoId}/simular-pagamento`, {
      method: "POST",
      headers: { Authorization: `Bearer ${registration.token}` },
    });
    const adminOrders = await request("/admin/pedidos", { headers: adminHeaders });
    const adminOrder = adminOrders.find((candidate) => candidate.id === order.pedidoId);
    if (!adminOrder) {
      throw new Error("O pedido não apareceu no painel administrativo.");
    }
    if (adminOrder.tipoEntrega !== "ENTREGA" || adminOrder.cepEntrega !== "01310100") {
      throw new Error("O tipo ou o endereço de entrega não foi preservado no pedido.");
    }
    await request(`/admin/pedidos/${order.pedidoId}/status`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ status: "Cancelado" }),
    });
    const cancelledList = await request(`/listas/${list.linkExclusivo}`);
    const productAfterCancellation = await request(`/produtos/${productId}`);
    if (cancelledList.produtos[0]?.comprado !== false) {
      throw new Error("O cancelamento não liberou novamente o presente.");
    }
    const stockMAfterCancellation = productAfterCancellation.estoquesPorTamanho.find(
      (stock) => stock.tamanho === "M",
    );
    if (productAfterCancellation.quantidadeEstoque !== 7 || stockMAfterCancellation?.quantidade !== 4) {
      throw new Error("O cancelamento não devolveu a unidade ao estoque.");
    }
    await request(`/admin/pedidos/${order.pedidoId}/status`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ status: "Em separação" }),
    });
    await request(`/admin/pedidos/${order.pedidoId}/status`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ status: "Entregue" }),
    });
    const confirmationAfterDelivery = await request(`/pedidos/${order.pedidoId}/simular-pagamento`, {
      method: "POST",
      headers: { Authorization: `Bearer ${registration.token}` },
    });
    const publicList = await request(`/listas/${list.linkExclusivo}`);
    const product = await request(`/produtos/${productId}`);

    if (firstConfirmation.idempotente !== false) throw new Error("A primeira confirmação não processou o pedido.");
    if (secondConfirmation.idempotente !== true) throw new Error("A segunda confirmação repetiu a baixa.");
    if (confirmationAfterDelivery.idempotente !== true) throw new Error("O reenvio após a entrega repetiu a baixa.");
    if (publicList.produtos[0]?.comprado !== true) throw new Error("O presente não foi marcado como comprado.");
    if (publicList.tema !== "MENINO") throw new Error("O tema escolhido não foi mantido na lista.");
    const stockBySize = Object.fromEntries(
      product.estoquesPorTamanho.map((stock) => [stock.tamanho, stock.quantidade]),
    );
    if (
      product.quantidadeEstoque !== 6 ||
      stockBySize.P !== 2 ||
      stockBySize.M !== 3 ||
      stockBySize.G !== 1
    ) {
      throw new Error("A baixa não foi aplicada somente ao tamanho comprado.");
    }

    console.log("Smoke test aprovado: autenticação, recuperação de senha, CEP, endereço, entrega, clientes, tema da lista, pedido, cancelamento, estoque por tamanho e idempotência.");
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
