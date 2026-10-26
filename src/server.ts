import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
import multer from "multer";
import path from "path";
import { MercadoPagoConfig, Payment } from "mercadopago";
import { prisma } from "./prisma";
import {
  createAuthToken,
  hashPassword,
  type AuthPayload,
  type Perfil,
  verifyAuthToken,
  verifyPassword,
} from "./auth";

type AuthenticatedRequest = Request & { auth?: AuthPayload };
type CartItemInput = {
  id?: unknown;
  produtoId?: unknown;
  quantidade?: unknown;
  listaPresenteId?: unknown;
  tamanho?: unknown;
};
type SizeStockEntry = {
  tamanho: string;
  quantidade: number;
  ordem: number;
};
type BabyListTheme = "MENINO" | "MENINA" | "NEUTRO";
type DeliveryType = "RETIRADA" | "ENTREGA";
type DeliveryAddress = {
  tipoEntrega: DeliveryType;
  cepEntrega: string | null;
  ruaEntrega: string | null;
  numeroEntrega: string | null;
  bairroEntrega: string | null;
  cidadeEntrega: string | null;
  estadoEntrega: string | null;
};
type ViaCepResponse = {
  erro?: boolean;
  cep?: string;
  logradouro?: string;
  bairro?: string;
  localidade?: string;
  uf?: string;
};

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const app = express();
const port = Number(process.env.PORT || 3333);
const frontendUrl = process.env.FRONTEND_URL?.trim() || "http://localhost:3000";
const passwordResetDurationMinutes = 30;
const tccDemoMode = process.env.TCC_DEMO_MODE === "true";

app.disable("x-powered-by");
app.use(cors({ origin: frontendUrl }));
app.use(express.json({ limit: "1mb" }));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

const uploadDirectory = path.resolve(process.cwd(), "uploads");
fs.mkdirSync(uploadDirectory, { recursive: true });
app.use("/uploads", express.static(uploadDirectory));

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, uploadDirectory),
  filename: (_req, file, callback) => {
    callback(null, `${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname)}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => callback(null, file.mimetype.startsWith("image/")),
});

const mercadoPagoToken = process.env.MERCADOPAGO_ACCESS_TOKEN?.trim() || "";
const payment = new Payment(new MercadoPagoConfig({ accessToken: mercadoPagoToken }));

function normalizeEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function requiredText(value: unknown, field: string) {
  const text = String(value || "").trim();
  if (!text) throw new HttpError(400, `O campo ${field} é obrigatório.`);
  return text;
}

function objectValue(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeDeliveryType(value: unknown): DeliveryType {
  const type = String(value || "RETIRADA").trim().toUpperCase();
  if (type !== "RETIRADA" && type !== "ENTREGA") {
    throw new HttpError(400, "Escolha retirada na loja ou entrega no endereço.");
  }
  return type;
}

async function lookupCep(value: unknown) {
  const cep = String(value || "").replace(/\D/g, "");
  if (cep.length !== 8) {
    throw new HttpError(400, "Informe um CEP válido com 8 dígitos.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`https://viacep.com.br/ws/${cep}/json/`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new HttpError(503, "O serviço de CEP está indisponível no momento.");
    }
    const address = (await response.json()) as ViaCepResponse;
    if (address.erro) throw new HttpError(404, "CEP não encontrado.");

    const cidade = requiredText(address.localidade, "cidade do CEP");
    const estado = requiredText(address.uf, "estado do CEP").toUpperCase();
    return {
      cep,
      rua: String(address.logradouro || "").trim(),
      bairro: String(address.bairro || "").trim(),
      cidade,
      estado,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "Não foi possível consultar o CEP agora. Tente novamente.");
  } finally {
    clearTimeout(timeout);
  }
}

async function validatedAddress(value: unknown) {
  const input = objectValue(value);
  const officialAddress = await lookupCep(input.cep);
  return {
    cep: officialAddress.cep,
    rua: requiredText(officialAddress.rua || input.rua, "rua"),
    numero: requiredText(input.numero, "número"),
    bairro: requiredText(officialAddress.bairro || input.bairro, "bairro"),
    cidade: officialAddress.cidade,
    estado: officialAddress.estado,
  };
}

async function deliveryAddress(value: unknown, paymentMethod: "PIX" | "WHATSAPP") {
  const input = objectValue(value);
  const tipoEntrega = normalizeDeliveryType(input.tipoEntrega);
  if (tipoEntrega === "RETIRADA") {
    return {
      tipoEntrega,
      cepEntrega: null,
      ruaEntrega: null,
      numeroEntrega: null,
      bairroEntrega: null,
      cidadeEntrega: null,
      estadoEntrega: null,
    } satisfies DeliveryAddress;
  }
  if (paymentMethod === "PIX") {
    throw new HttpError(
      400,
      "Pedidos com entrega devem ser finalizados pelo WhatsApp para combinar a taxa.",
    );
  }
  const address = await validatedAddress(input);
  return {
    tipoEntrega,
    cepEntrega: address.cep,
    ruaEntrega: address.rua,
    numeroEntrega: address.numero,
    bairroEntrega: address.bairro,
    cidadeEntrega: address.cidade,
    estadoEntrega: address.estado,
  } satisfies DeliveryAddress;
}

function positiveInteger(value: unknown, field: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new HttpError(400, `${field} deve ser um número inteiro positivo.`);
  }
  return number;
}

function nonNegativeInteger(value: unknown, field: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new HttpError(400, `${field} deve ser um número inteiro maior ou igual a zero.`);
  }
  return number;
}

function positiveMoney(value: unknown, field: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new HttpError(400, `${field} deve ser um valor maior que zero.`);
  }
  return Number(number.toFixed(2));
}

function normalizeSizes(value: unknown) {
  const sizes = String(value || "Único")
    .split(",")
    .map((size) => size.trim())
    .filter(Boolean);
  const uniqueSizes = sizes.filter(
    (size, index) =>
      sizes.findIndex(
        (candidate) => candidate.toLocaleLowerCase("pt-BR") === size.toLocaleLowerCase("pt-BR"),
      ) === index,
  );
  return (uniqueSizes.length > 0 ? uniqueSizes : ["Único"]).join(", ");
}

function parseSizeStocks(
  value: unknown,
  sizesValue: unknown,
  totalValue: unknown,
): { tamanhos: string; quantidadeEstoque: number; estoques: SizeStockEntry[] } {
  let parsedValue = value;
  if (typeof value === "string" && value.trim()) {
    try {
      parsedValue = JSON.parse(value);
    } catch {
      throw new HttpError(400, "O estoque por tamanho está em um formato inválido.");
    }
  }

  let rawEntries: Array<{ tamanho: unknown; quantidade: unknown }> = [];
  if (Array.isArray(parsedValue)) {
    rawEntries = parsedValue.map((entry) => {
      if (!entry || typeof entry !== "object") {
        throw new HttpError(400, "Informe uma quantidade válida para cada tamanho.");
      }
      const candidate = entry as Record<string, unknown>;
      return { tamanho: candidate.tamanho, quantidade: candidate.quantidade };
    });
  } else if (parsedValue && typeof parsedValue === "object") {
    rawEntries = Object.entries(parsedValue as Record<string, unknown>).map(
      ([tamanho, quantidade]) => ({ tamanho, quantidade }),
    );
  }

  if (rawEntries.length === 0) {
    const sizes = availableSizes(normalizeSizes(sizesValue));
    const total = nonNegativeInteger(totalValue, "quantidade em estoque");
    const base = Math.floor(total / sizes.length);
    const remainder = total % sizes.length;
    const estoques = sizes.map((tamanho, ordem) => ({
      tamanho,
      quantidade: base + (ordem < remainder ? 1 : 0),
      ordem,
    }));
    return { tamanhos: sizes.join(", "), quantidadeEstoque: total, estoques };
  }

  const estoques = rawEntries.map((entry, ordem) => ({
    tamanho: requiredText(entry.tamanho, "tamanho"),
    quantidade: nonNegativeInteger(entry.quantidade, "quantidade do tamanho"),
    ordem,
  }));
  const duplicateSize = estoques.find(
    (entry, index) =>
      estoques.findIndex(
        (candidate) =>
          candidate.tamanho.toLocaleLowerCase("pt-BR") ===
          entry.tamanho.toLocaleLowerCase("pt-BR"),
      ) !== index,
  );
  if (duplicateSize) {
    throw new HttpError(400, `O tamanho ${duplicateSize.tamanho} foi informado mais de uma vez.`);
  }

  return {
    tamanhos: estoques.map((entry) => entry.tamanho).join(", "),
    quantidadeEstoque: estoques.reduce((total, entry) => total + entry.quantidade, 0),
    estoques,
  };
}

function stockForSize(
  stocks: Array<{ tamanho: string; quantidade: number }>,
  size: string,
) {
  return stocks.find(
    (stock) => stock.tamanho.toLocaleLowerCase("pt-BR") === size.toLocaleLowerCase("pt-BR"),
  );
}

function removeUploadedFile(filePath: string | null | undefined) {
  if (!filePath) return;
  fs.unlink(filePath, () => undefined);
}

function isValidCpf(value: unknown) {
  const cpf = String(value || "").replace(/\D/g, "");
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;

  const calculateDigit = (length: number) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(cpf[index]) * (length + 1 - index);
    }
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };

  return calculateDigit(9) === Number(cpf[9]) && calculateDigit(10) === Number(cpf[10]);
}

function availableSizes(value: string | null) {
  const sizes = String(value || "Único")
    .split(",")
    .map((size) => size.trim())
    .filter(Boolean);
  return sizes.length > 0 ? sizes : ["Único"];
}

function validProductSize(value: unknown, sizesValue: string | null) {
  const sizes = availableSizes(sizesValue);
  const requestedSize = String(value || "").trim();
  const resolvedSize = requestedSize || (sizes.length === 1 ? sizes[0] : "");
  if (!resolvedSize) throw new HttpError(400, "Selecione o tamanho do produto.");
  const matchedSize = sizes.find(
    (size) => size.toLocaleLowerCase("pt-BR") === resolvedSize.toLocaleLowerCase("pt-BR"),
  );
  if (!matchedSize) {
    throw new HttpError(400, "Tamanho inválido. Opções disponíveis: " + sizes.join(", ") + ".");
  }
  return matchedSize;
}

function parseEventDate(value: unknown) {
  const text = String(value || "").trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T12:00:00.000Z`)
    : new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, "Informe uma data válida para o evento.");
  }
  return date;
}

function normalizeBabyListTheme(value: unknown): BabyListTheme {
  const theme = String(value || "NEUTRO").trim().toUpperCase();
  if (theme === "MENINO" || theme === "MENINA" || theme === "NEUTRO") return theme;
  throw new HttpError(400, "Escolha um tema válido para a lista: menino, menina ou neutro.");
}

function requireAuth(allowedProfiles: Perfil[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const authorization = req.header("authorization");
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : null;
    const payload = token ? verifyAuthToken(token) : null;

    if (!payload) {
      res.status(401).json({ error: "Sessão inválida ou expirada. Entre novamente." });
      return;
    }
    if (!allowedProfiles.includes(payload.perfil)) {
      res.status(403).json({ error: "Você não tem permissão para esta operação." });
      return;
    }
    req.auth = payload;
    next();
  };
}

function createRateLimiter(windowMs: number, maxAttempts: number, message: string) {
  const attempts = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (attempts.size > 1_000) {
      for (const [key, value] of attempts) {
        if (value.resetAt <= now) attempts.delete(key);
      }
    }

    const address = req.ip || req.socket.remoteAddress || "desconhecido";
    const key = `${address}:${req.path}`;
    const current = attempts.get(key);

    if (!current || current.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (current.count >= maxAttempts) {
      res.setHeader("Retry-After", Math.ceil((current.resetAt - now) / 1_000));
      res.status(429).json({ error: message });
      return;
    }

    current.count += 1;
    next();
  };
}

const loginRateLimiter = createRateLimiter(
  15 * 60 * 1_000,
  10,
  "Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente.",
);
const passwordRecoveryRateLimiter = createRateLimiter(
  15 * 60 * 1_000,
  5,
  "Muitas solicitações de recuperação. Aguarde alguns minutos e tente novamente.",
);

function safeCliente<T extends { senha: string }>(cliente: T) {
  const { senha: _senha, ...safeData } = cliente;
  return safeData;
}

function errorResponse(error: unknown, res: Response, fallback: string) {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(fallback, error);
  res.status(500).json({ error: fallback });
}

function mercadoPagoErrorText(error: unknown) {
  if (!error || typeof error !== "object") return String(error || "");
  const paymentError = error as {
    message?: unknown;
    cause?: Array<{ code?: unknown; description?: unknown }>;
  };
  const causes = Array.isArray(paymentError.cause)
    ? paymentError.cause.flatMap((cause) => [cause.code, cause.description])
    : [];
  return [paymentError.message, ...causes]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLocaleLowerCase("pt-BR");
}

function friendlyMercadoPagoError(error: unknown) {
  const details = mercadoPagoErrorText(error);
  const sameAccount =
    (details.includes("payer") && details.includes("collector")) ||
    details.includes("same user") ||
    details.includes("mesmo usuário");

  if (sameAccount) {
    return new HttpError(
      400,
      "O e-mail deste cliente pertence à conta vendedora do Mercado Pago. Para testar o PIX, entre como cliente usando outro e-mail.",
    );
  }
  if (details.includes("identification") || details.includes("cpf")) {
    return new HttpError(400, "O Mercado Pago recusou o CPF informado. Revise o cadastro do cliente.");
  }
  return new HttpError(
    502,
    "O Mercado Pago não conseguiu gerar o PIX agora. Tente novamente ou finalize pelo WhatsApp.",
  );
}

async function ensureAdminUser() {
  const email = normalizeEmail(process.env.ADMIN_EMAIL || "admin@pegadakids.com.br");
  const password = process.env.ADMIN_PASSWORD?.trim();
  const name = process.env.ADMIN_NAME?.trim() || "Administrador Pegada Kids";
  const existingAdmin = await prisma.usuario.findUnique({ where: { email } });

  if (!existingAdmin) {
    if (!password || password.length < 8) {
      throw new Error(
        "Defina ADMIN_PASSWORD no .env com pelo menos 8 caracteres antes de criar o administrador.",
      );
    }
    await prisma.usuario.create({
      data: { nome: name, email, senha: hashPassword(password) },
    });
    console.log(`Administrador inicial criado: ${email}`);
  }
  if (!process.env.ADMIN_PASSWORD) {
    console.warn("AVISO: defina ADMIN_PASSWORD no .env antes de publicar o sistema.");
  }
}

async function createGiftList(
  clienteId: number,
  nomeBebeValue: unknown,
  dataEventoValue: unknown,
  themeValue: unknown,
  productIds: number[] = [],
) {
  const nomeBebe = requiredText(nomeBebeValue, "nome do bebê");
  const dataEvento = parseEventDate(dataEventoValue);
  const tema = normalizeBabyListTheme(themeValue);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (dataEvento < today) {
    throw new HttpError(400, "A data do evento não pode estar no passado.");
  }
  const uniqueProductIds = [...new Set(productIds)];
  const products = uniqueProductIds.length
    ? await prisma.produto.findMany({
        where: { id: { in: uniqueProductIds } },
        include: { estoquesPorTamanho: { orderBy: { ordem: "asc" } } },
      })
    : [];
  if (products.length !== uniqueProductIds.length) {
    throw new HttpError(400, "Um ou mais produtos selecionados não existem.");
  }
  const initialProducts = products.map((product) => {
    const tamanho =
      product.estoquesPorTamanho.find((stock) => stock.quantidade > 0)?.tamanho ||
      availableSizes(product.tamanhos)[0] ||
      "Único";
    return { produtoId: product.id, tamanho };
  });

  return prisma.listaPresente.create({
    data: {
      clienteId,
      nomeBebe,
      dataEvento,
      tema,
      linkExclusivo: crypto.randomUUID(),
      ...(initialProducts.length
        ? { produtos: { create: initialProducts } }
        : {}),
    },
    include: {
      cliente: { select: { id: true, nome: true, email: true } },
      produtos: {
        include: {
          produto: { include: { estoquesPorTamanho: { orderBy: { ordem: "asc" } } } },
        },
      },
    },
  });
}

async function createPendingOrder(
  clienteId: number,
  itemsValue: unknown,
  paymentMethod: "PIX" | "WHATSAPP",
  deliveryValue: unknown,
) {
  if (!Array.isArray(itemsValue) || itemsValue.length === 0) {
    throw new HttpError(400, "O carrinho está vazio.");
  }

  const normalizedItems = (itemsValue as CartItemInput[]).map((item) => ({
    produtoId: positiveInteger(item.produtoId ?? item.id, "produtoId"),
    quantidade: positiveInteger(item.quantidade ?? 1, "quantidade"),
    listaPresenteId:
      item.listaPresenteId === undefined || item.listaPresenteId === null
        ? null
        : positiveInteger(item.listaPresenteId, "listaPresenteId"),
    tamanho: String(item.tamanho || "").trim() || null,
  }));

  const productIds = [...new Set(normalizedItems.map((item) => item.produtoId))];
  const products = await prisma.produto.findMany({
    where: { id: { in: productIds } },
    include: { estoquesPorTamanho: { orderBy: { ordem: "asc" } } },
  });
  const productMap = new Map(products.map((product) => [product.id, product]));

  for (const item of normalizedItems) {
    const product = productMap.get(item.produtoId);
    if (!product) throw new HttpError(404, `Produto ${item.produtoId} não encontrado.`);
    if (item.listaPresenteId) {
      if (item.quantidade !== 1) {
        throw new HttpError(400, "Cada item de uma lista de presentes pode ser comprado uma única vez.");
      }
      const giftItem = await prisma.listaPresenteProduto.findUnique({
        where: {
          listaId_produtoId: {
            listaId: item.listaPresenteId,
            produtoId: item.produtoId,
          },
        },
      });
      if (!giftItem) throw new HttpError(400, `${product.nome} não pertence à lista informada.`);
      if (giftItem.comprado) throw new HttpError(409, `${product.nome} já foi presenteado.`);
      item.tamanho = giftItem.tamanho || item.tamanho;
    }
    item.tamanho = validProductSize(item.tamanho, product.tamanhos);
    const sizeStock = stockForSize(product.estoquesPorTamanho, item.tamanho);
    if (!sizeStock || sizeStock.quantidade < item.quantidade) {
      throw new HttpError(
        409,
        `Estoque insuficiente para ${product.nome} no tamanho ${item.tamanho}.`,
      );
    }
  }

  const total = normalizedItems.reduce((sum, item) => {
    return sum + Number(productMap.get(item.produtoId)!.preco) * item.quantidade;
  }, 0);
  const delivery = await deliveryAddress(deliveryValue, paymentMethod);

  return prisma.pedido.create({
    data: {
      clienteId,
      valorTotal: Number(total.toFixed(2)),
      status: "Pendente",
      metodoPagamento: paymentMethod,
      isPresente: normalizedItems.some((item) => Boolean(item.listaPresenteId)),
      ...delivery,
      itens: {
        create: normalizedItems.map((item) => ({
          produtoId: item.produtoId,
          quantidade: item.quantidade,
          precoUnitario: productMap.get(item.produtoId)!.preco,
          listaPresenteId: item.listaPresenteId,
          tamanho: item.tamanho,
        })),
      },
    },
    include: { itens: { include: { produto: true } } },
  });
}

async function processApprovedOrder(pedidoId: number, mercadoPagoId?: string) {
  return prisma.$transaction(async (transaction) => {
    const changed = await transaction.pedido.updateMany({
      where: { id: pedidoId, processadoEm: null },
      data: {
        status: "Aprovado",
        processadoEm: new Date(),
        ...(mercadoPagoId ? { mercadoPagoId } : {}),
      },
    });

    if (changed.count === 0) {
      const existingOrder = await transaction.pedido.findUnique({ where: { id: pedidoId } });
      if (!existingOrder) throw new HttpError(404, "Pedido não encontrado.");
      return { alreadyProcessed: true, order: existingOrder };
    }

    const order = await transaction.pedido.findUnique({
      where: { id: pedidoId },
      include: { itens: true },
    });
    if (!order) throw new HttpError(404, "Pedido não encontrado.");

    for (const item of order.itens) {
      if (item.listaPresenteId) {
        const giftUpdated = await transaction.listaPresenteProduto.updateMany({
          where: {
            listaId: item.listaPresenteId,
            produtoId: item.produtoId,
            comprado: false,
          },
          data: { comprado: true, compradoEm: new Date() },
        });
        if (giftUpdated.count === 0) {
          throw new HttpError(409, "Um dos presentes já foi comprado por outro convidado.");
        }
      }

      const tamanho = item.tamanho || "Único";
      const sizeStockUpdated = await transaction.estoqueProdutoTamanho.updateMany({
        where: {
          produtoId: item.produtoId,
          tamanho,
          quantidade: { gte: item.quantidade },
        },
        data: { quantidade: { decrement: item.quantidade } },
      });
      if (sizeStockUpdated.count === 0) {
        throw new HttpError(
          409,
          `Estoque insuficiente no tamanho ${tamanho} durante a confirmação do pedido.`,
        );
      }

      const stockUpdated = await transaction.produto.updateMany({
        where: { id: item.produtoId, quantidadeEstoque: { gte: item.quantidade } },
        data: { quantidadeEstoque: { decrement: item.quantidade } },
      });
      if (stockUpdated.count === 0) {
        throw new HttpError(409, "Estoque insuficiente durante a confirmação do pedido.");
      }
    }
    return { alreadyProcessed: false, order };
  });
}

async function cancelProcessedOrder(pedidoId: number, status: "Cancelado" | "Falha no pagamento") {
  return prisma.$transaction(async (transaction) => {
    const changed = await transaction.pedido.updateMany({
      where: { id: pedidoId, processadoEm: { not: null } },
      data: { status, processadoEm: null },
    });

    if (changed.count === 0) {
      const existingOrder = await transaction.pedido.findUnique({ where: { id: pedidoId } });
      if (!existingOrder) throw new HttpError(404, "Pedido não encontrado.");
      await transaction.pedido.update({ where: { id: pedidoId }, data: { status } });
      return { stockRestored: false };
    }

    const order = await transaction.pedido.findUnique({
      where: { id: pedidoId },
      include: { itens: true },
    });
    if (!order) throw new HttpError(404, "Pedido não encontrado.");

    for (const item of order.itens) {
      const tamanho = item.tamanho || "Único";
      await transaction.estoqueProdutoTamanho.upsert({
        where: {
          produtoId_tamanho: { produtoId: item.produtoId, tamanho },
        },
        update: { quantidade: { increment: item.quantidade } },
        create: {
          produtoId: item.produtoId,
          tamanho,
          quantidade: item.quantidade,
          ordem: 0,
        },
      });
      await transaction.produto.update({
        where: { id: item.produtoId },
        data: { quantidadeEstoque: { increment: item.quantidade } },
      });
      if (item.listaPresenteId) {
        await transaction.listaPresenteProduto.updateMany({
          where: {
            listaId: item.listaPresenteId,
            produtoId: item.produtoId,
            comprado: true,
          },
          data: { comprado: false, compradoEm: null },
        });
      }
    }

    return { stockRestored: true };
  });
}

app.get("/saude", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/auth/admin/login", loginRateLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = requiredText(req.body.senha, "senha");
    const user = await prisma.usuario.findUnique({ where: { email } });
    if (!user || !verifyPassword(password, user.senha)) {
      throw new HttpError(401, "E-mail ou senha inválidos.");
    }
    res.json({
      token: createAuthToken(user.id, "ADMIN"),
      usuario: { id: user.id, nome: user.nome, email: user.email },
    });
  } catch (error) {
    errorResponse(error, res, "Erro ao autenticar o administrador.");
  }
});

app.post("/auth/clientes/login", loginRateLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = requiredText(req.body.senha, "senha");
    const client = await prisma.cliente.findUnique({ where: { email } });
    if (!client || !verifyPassword(password, client.senha)) {
      throw new HttpError(401, "E-mail ou senha inválidos.");
    }
    res.json({
      token: createAuthToken(client.id, "CLIENTE"),
      cliente: safeCliente(client),
    });
  } catch (error) {
    errorResponse(error, res, "Erro ao autenticar o cliente.");
  }
});

app.post("/auth/recuperar-senha", passwordRecoveryRateLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const perfil: Perfil = req.body.perfil === "ADMIN" ? "ADMIN" : "CLIENTE";
    if (!email.includes("@")) throw new HttpError(400, "Informe um e-mail válido.");

    const account =
      perfil === "ADMIN"
        ? await prisma.usuario.findUnique({ where: { email }, select: { id: true } })
        : await prisma.cliente.findUnique({ where: { email }, select: { id: true } });

    let resetUrl: string | undefined;
    if (account) {
      const token = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const expiraEm = new Date(Date.now() + passwordResetDurationMinutes * 60 * 1000);

      await prisma.$transaction([
        prisma.recuperacaoSenha.updateMany({
          where: { email, perfil, usadoEm: null },
          data: { usadoEm: new Date() },
        }),
        prisma.recuperacaoSenha.create({
          data: { email, perfil, tokenHash, expiraEm },
        }),
      ]);

      resetUrl = `${frontendUrl}/recuperar-senha?token=${token}`;
      console.log(`Recuperação de senha (${perfil}): ${resetUrl}`);
    }

    const exposeLocalLink = process.env.EXPOSE_PASSWORD_RESET_LINK === "true";
    res.json({
      message:
        "Se o e-mail estiver cadastrado, um link de recuperação válido por 30 minutos foi gerado.",
      ...(exposeLocalLink && resetUrl ? { resetUrl } : {}),
    });
  } catch (error) {
    errorResponse(error, res, "Erro ao solicitar a recuperação da senha.");
  }
});

app.post("/auth/redefinir-senha", passwordRecoveryRateLimiter, async (req, res) => {
  try {
    const token = requiredText(req.body.token, "token de recuperação");
    const newPassword = requiredText(req.body.novaSenha, "nova senha");
    if (newPassword.length < 8) {
      throw new HttpError(400, "A nova senha deve ter pelo menos 8 caracteres.");
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const recovery = await prisma.recuperacaoSenha.findUnique({ where: { tokenHash } });
    if (!recovery || recovery.usadoEm || recovery.expiraEm <= new Date()) {
      throw new HttpError(400, "Este link é inválido ou expirou. Solicite uma nova recuperação.");
    }

    await prisma.$transaction(async (transaction) => {
      const claimed = await transaction.recuperacaoSenha.updateMany({
        where: { id: recovery.id, usadoEm: null, expiraEm: { gt: new Date() } },
        data: { usadoEm: new Date() },
      });
      if (claimed.count !== 1) {
        throw new HttpError(400, "Este link já foi utilizado. Solicite uma nova recuperação.");
      }

      const updated =
        recovery.perfil === "ADMIN"
          ? await transaction.usuario.updateMany({
              where: { email: recovery.email },
              data: { senha: hashPassword(newPassword) },
            })
          : await transaction.cliente.updateMany({
              where: { email: recovery.email },
              data: { senha: hashPassword(newPassword) },
            });
      if (updated.count !== 1) {
        throw new HttpError(400, "A conta associada a este link não está mais disponível.");
      }

      await transaction.recuperacaoSenha.updateMany({
        where: { email: recovery.email, perfil: recovery.perfil, usadoEm: null },
        data: { usadoEm: new Date() },
      });
    });

    res.json({
      message: "Senha redefinida com sucesso. Agora você já pode entrar.",
      perfil: recovery.perfil,
    });
  } catch (error) {
    errorResponse(error, res, "Erro ao redefinir a senha.");
  }
});

app.post("/clientes", async (req, res) => {
  try {
    const nome = requiredText(req.body.nome, "nome");
    const email = normalizeEmail(req.body.email);
    const password = requiredText(req.body.senha, "senha");
    const cpf = String(req.body.cpf || "").replace(/\D/g, "");
    if (!email.includes("@")) throw new HttpError(400, "Informe um e-mail válido.");
    if (password.length < 8) throw new HttpError(400, "A senha deve ter pelo menos 8 caracteres.");
    if (!isValidCpf(cpf)) throw new HttpError(400, "Informe um CPF válido.");

    const duplicate = await prisma.cliente.findFirst({ where: { OR: [{ email }, { cpf }] } });
    if (duplicate) throw new HttpError(409, "E-mail ou CPF já cadastrado.");

    const client = await prisma.cliente.create({
      data: {
        nome,
        email,
        senha: hashPassword(password),
        cpf,
        telefone: req.body.telefone ? String(req.body.telefone) : null,
        cep: req.body.cep ? String(req.body.cep) : null,
        rua: req.body.rua ? String(req.body.rua) : null,
        numero: req.body.numero ? String(req.body.numero) : null,
        bairro: req.body.bairro ? String(req.body.bairro) : null,
        cidade: req.body.cidade ? String(req.body.cidade) : "Paraguaçu Paulista",
        estado: req.body.estado ? String(req.body.estado) : "SP",
      },
    });
    res.status(201).json({
      message: "Conta criada com sucesso.",
      token: createAuthToken(client.id, "CLIENTE"),
      cliente: safeCliente(client),
    });
  } catch (error) {
    errorResponse(error, res, "Erro ao criar a conta.");
  }
});

app.get("/clientes/me", requireAuth(["CLIENTE"]), async (req: AuthenticatedRequest, res) => {
  try {
    const client = await prisma.cliente.findUnique({ where: { id: req.auth!.sub } });
    if (!client) throw new HttpError(404, "Cliente não encontrado.");
    res.json(safeCliente(client));
  } catch (error) {
    errorResponse(error, res, "Erro ao carregar os dados do cliente.");
  }
});

app.get("/enderecos/cep/:cep", requireAuth(["CLIENTE"]), async (req, res) => {
  try {
    res.json(await lookupCep(req.params.cep));
  } catch (error) {
    errorResponse(error, res, "Erro ao consultar o CEP.");
  }
});

app.patch("/clientes/me/endereco", requireAuth(["CLIENTE"]), async (req: AuthenticatedRequest, res) => {
  try {
    const address = await validatedAddress(req.body);

    const client = await prisma.cliente.update({
      where: { id: req.auth!.sub },
      data: {
        cep: address.cep,
        rua: address.rua,
        numero: address.numero,
        bairro: address.bairro,
        cidade: address.cidade,
        estado: address.estado,
        ...(req.body.telefone ? { telefone: String(req.body.telefone).trim() } : {}),
      },
    });
    res.json({ message: "Endereço atualizado com sucesso.", cliente: safeCliente(client) });
  } catch (error) {
    errorResponse(error, res, "Erro ao atualizar o endereço.");
  }
});

app.get("/admin/clientes", requireAuth(["ADMIN"]), async (_req, res) => {
  try {
    const clients = await prisma.cliente.findMany({
      select: {
        id: true,
        nome: true,
        email: true,
        cpf: true,
        telefone: true,
        cep: true,
        rua: true,
        numero: true,
        bairro: true,
        cidade: true,
        estado: true,
        _count: { select: { pedidos: true, listas: true } },
      },
      orderBy: { nome: "asc" },
    });
    res.json(clients);
  } catch (error) {
    errorResponse(error, res, "Erro ao carregar os clientes.");
  }
});

app.patch("/admin/clientes/:id", requireAuth(["ADMIN"]), async (req, res) => {
  try {
    const clienteId = positiveInteger(req.params.id, "id");
    const nome = requiredText(req.body.nome, "nome");
    const email = normalizeEmail(req.body.email);
    const cpf = String(req.body.cpf || "").replace(/\D/g, "");
    if (!email.includes("@")) throw new HttpError(400, "Informe um e-mail válido.");
    if (cpf && !isValidCpf(cpf)) throw new HttpError(400, "Informe um CPF válido.");

    const duplicate = await prisma.cliente.findFirst({
      where: {
        id: { not: clienteId },
        OR: [{ email }, ...(cpf ? [{ cpf }] : [])],
      },
    });
    if (duplicate) throw new HttpError(409, "E-mail ou CPF já pertence a outro cliente.");

    const client = await prisma.cliente.update({
      where: { id: clienteId },
      data: {
        nome,
        email,
        cpf: cpf || null,
        telefone: req.body.telefone ? String(req.body.telefone).trim() : null,
        cep: req.body.cep ? String(req.body.cep).trim() : null,
        rua: req.body.rua ? String(req.body.rua).trim() : null,
        numero: req.body.numero ? String(req.body.numero).trim() : null,
        bairro: req.body.bairro ? String(req.body.bairro).trim() : null,
        cidade: req.body.cidade ? String(req.body.cidade).trim() : null,
        estado: req.body.estado ? String(req.body.estado).trim().toUpperCase() : null,
      },
    });
    res.json({ message: "Cliente atualizado com sucesso.", cliente: safeCliente(client) });
  } catch (error) {
    errorResponse(error, res, "Erro ao atualizar o cliente.");
  }
});

app.delete("/admin/clientes/:id", requireAuth(["ADMIN"]), async (req, res) => {
  try {
    const clienteId = positiveInteger(req.params.id, "id");
    const client = await prisma.cliente.findUnique({
      where: { id: clienteId },
      include: { _count: { select: { pedidos: true, listas: true } } },
    });
    if (!client) throw new HttpError(404, "Cliente não encontrado.");
    if (client._count.pedidos > 0 || client._count.listas > 0) {
      throw new HttpError(
        409,
        "Este cliente possui pedidos ou listas e não pode ser excluído sem perder o histórico.",
      );
    }
    await prisma.cliente.delete({ where: { id: clienteId } });
    res.json({ message: "Cliente excluído com sucesso." });
  } catch (error) {
    errorResponse(error, res, "Erro ao excluir o cliente.");
  }
});

app.get("/produtos", async (_req, res) => {
  try {
    res.json(
      await prisma.produto.findMany({
        orderBy: { id: "desc" },
        include: { estoquesPorTamanho: { orderBy: { ordem: "asc" } } },
      }),
    );
  } catch (error) {
    errorResponse(error, res, "Erro ao buscar o catálogo.");
  }
});

app.get("/produtos/:id", async (req, res) => {
  try {
    const product = await prisma.produto.findUnique({
      where: { id: positiveInteger(req.params.id, "id") },
      include: { estoquesPorTamanho: { orderBy: { ordem: "asc" } } },
    });
    if (!product) throw new HttpError(404, "Produto não encontrado.");
    res.json(product);
  } catch (error) {
    errorResponse(error, res, "Erro ao buscar o produto.");
  }
});

app.post("/produtos", requireAuth(["ADMIN"]), upload.single("foto"), async (req, res) => {
  try {
    const sizeStocks = parseSizeStocks(
      req.body.estoquesPorTamanho,
      req.body.tamanhos,
      req.body.quantidadeEstoque,
    );
    const product = await prisma.produto.create({
      data: {
        nome: requiredText(req.body.nome, "nome"),
        preco: positiveMoney(req.body.preco, "preço"),
        descricao: String(req.body.descricao || "").trim(),
        quantidadeEstoque: sizeStocks.quantidadeEstoque,
        imagemUrl: req.file ? `/uploads/${req.file.filename}` : null,
        categoria: requiredText(req.body.categoria, "categoria"),
        tamanhos: sizeStocks.tamanhos,
        estoquesPorTamanho: {
          create: sizeStocks.estoques,
        },
      },
      include: { estoquesPorTamanho: { orderBy: { ordem: "asc" } } },
    });
    res.status(201).json({ message: "Produto cadastrado com sucesso.", produto: product });
  } catch (error) {
    removeUploadedFile(req.file?.path);
    errorResponse(error, res, "Erro ao cadastrar o produto.");
  }
});

app.put("/produtos/:id", requireAuth(["ADMIN"]), upload.single("foto"), async (req, res) => {
  try {
    const productId = positiveInteger(req.params.id, "id");
    const existingProduct = await prisma.produto.findUnique({ where: { id: productId } });
    if (!existingProduct) throw new HttpError(404, "Produto não encontrado.");
    const sizeStocks = parseSizeStocks(
      req.body.estoquesPorTamanho,
      req.body.tamanhos,
      req.body.quantidadeEstoque,
    );
    const product = await prisma.produto.update({
      where: { id: productId },
      data: {
        nome: requiredText(req.body.nome, "nome"),
        preco: positiveMoney(req.body.preco, "preço"),
        descricao: String(req.body.descricao || "").trim(),
        quantidadeEstoque: sizeStocks.quantidadeEstoque,
        categoria: requiredText(req.body.categoria, "categoria"),
        tamanhos: sizeStocks.tamanhos,
        ...(req.file ? { imagemUrl: `/uploads/${req.file.filename}` } : {}),
        estoquesPorTamanho: {
          deleteMany: {},
          create: sizeStocks.estoques,
        },
      },
      include: { estoquesPorTamanho: { orderBy: { ordem: "asc" } } },
    });
    if (req.file && existingProduct.imagemUrl) {
      removeUploadedFile(path.join(process.cwd(), existingProduct.imagemUrl.replace(/^\//, "")));
    }
    res.json({ message: "Produto atualizado com sucesso.", produto: product });
  } catch (error) {
    removeUploadedFile(req.file?.path);
    errorResponse(error, res, "Erro ao atualizar o produto.");
  }
});

app.delete("/produtos/:id", requireAuth(["ADMIN"]), async (req, res) => {
  try {
    const productId = positiveInteger(req.params.id, "id");
    const product = await prisma.produto.findUnique({
      where: { id: productId },
      include: { _count: { select: { itensPedido: true, listasPresentes: true } } },
    });
    if (!product) throw new HttpError(404, "Produto não encontrado.");
    if (product._count.itensPedido > 0 || product._count.listasPresentes > 0) {
      throw new HttpError(
        409,
        "Este produto já faz parte de pedidos ou listas. Zere o estoque para ocultá-lo sem perder o histórico.",
      );
    }
    await prisma.produto.delete({ where: { id: productId } });
    if (product.imagemUrl) {
      removeUploadedFile(path.join(process.cwd(), product.imagemUrl.replace(/^\//, "")));
    }
    res.json({ message: "Produto excluído com sucesso." });
  } catch (error) {
    errorResponse(error, res, "Erro ao excluir o produto.");
  }
});

app.get("/listas/buscar", async (req, res) => {
  try {
    const query = requiredText(req.query.q, "busca");
    const lists = await prisma.listaPresente.findMany({
      where: {
        OR: [
          { nomeBebe: { contains: query, mode: "insensitive" } },
          { cliente: { nome: { contains: query, mode: "insensitive" } } },
          { linkExclusivo: { contains: query, mode: "insensitive" } },
        ],
      },
      select: {
        id: true,
        nomeBebe: true,
        dataEvento: true,
        tema: true,
        linkExclusivo: true,
        cliente: { select: { nome: true } },
      },
      orderBy: { dataEvento: "desc" },
      take: 20,
    });
    res.json(lists);
  } catch (error) {
    errorResponse(error, res, "Erro ao pesquisar listas.");
  }
});

app.get("/listas/painel/:id", requireAuth(["CLIENTE", "ADMIN"]), async (req: AuthenticatedRequest, res) => {
  try {
    const list = await prisma.listaPresente.findUnique({
      where: { id: positiveInteger(req.params.id, "id") },
      include: {
        cliente: { select: { id: true, nome: true, email: true } },
        produtos: {
          include: {
            produto: { include: { estoquesPorTamanho: { orderBy: { ordem: "asc" } } } },
          },
        },
      },
    });
    if (!list) throw new HttpError(404, "Lista não encontrada.");
    if (req.auth?.perfil === "CLIENTE" && list.clienteId !== req.auth.sub) {
      throw new HttpError(403, "Esta lista pertence a outro cliente.");
    }
    res.json(list);
  } catch (error) {
    errorResponse(error, res, "Erro ao carregar a lista.");
  }
});

app.get("/listas/:link", async (req, res) => {
  try {
    const link = requiredText(req.params.link, "link");
    const list = await prisma.listaPresente.findFirst({
      where: { OR: [{ linkExclusivo: link }, { linkExclusivo: { endsWith: `/${link}` } }] },
      include: {
        cliente: { select: { nome: true } },
        produtos: {
          include: {
            produto: { include: { estoquesPorTamanho: { orderBy: { ordem: "asc" } } } },
          },
        },
      },
    });
    if (!list) throw new HttpError(404, "Lista não encontrada.");
    res.json(list);
  } catch (error) {
    errorResponse(error, res, "Erro ao buscar a lista.");
  }
});

app.post("/listas", requireAuth(["CLIENTE"]), async (req: AuthenticatedRequest, res) => {
  try {
    const list = await createGiftList(
      req.auth!.sub,
      req.body.nomeBebe,
      req.body.dataEvento,
      req.body.tema,
    );
    res.status(201).json(list);
  } catch (error) {
    errorResponse(error, res, "Erro ao criar a lista.");
  }
});

app.post("/admin/listas", requireAuth(["ADMIN"]), async (req, res) => {
  try {
    const email = normalizeEmail(req.body.emailCliente);
    const client = await prisma.cliente.findUnique({ where: { email } });
    if (!client) throw new HttpError(404, "Cliente não encontrado para esse e-mail.");
    const productIds = Array.isArray(req.body.produtosIds)
      ? req.body.produtosIds.map((id: unknown) => positiveInteger(id, "produtoId"))
      : [];
    const list = await createGiftList(
      client.id,
      req.body.nomeBebe,
      req.body.dataEvento,
      req.body.tema,
      productIds,
    );
    res.status(201).json(list);
  } catch (error) {
    errorResponse(error, res, "Erro ao criar a lista pelo painel.");
  }
});

app.get("/admin/listas", requireAuth(["ADMIN"]), async (_req, res) => {
  try {
    const lists = await prisma.listaPresente.findMany({
      include: {
        cliente: {
          select: { id: true, nome: true, email: true, telefone: true },
        },
        produtos: {
          include: {
            produto: { include: { estoquesPorTamanho: { orderBy: { ordem: "asc" } } } },
          },
          orderBy: { comprado: "asc" },
        },
      },
      orderBy: { dataEvento: "desc" },
    });
    res.json(lists);
  } catch (error) {
    errorResponse(error, res, "Erro ao carregar as listas de Chá de Bebê.");
  }
});

app.patch("/admin/listas/:id", requireAuth(["ADMIN"]), async (req, res) => {
  try {
    const listaId = positiveInteger(req.params.id, "id");
    const nomeBebe = requiredText(req.body.nomeBebe, "nome do bebê");
    const dataEvento = parseEventDate(req.body.dataEvento);
    const existing = await prisma.listaPresente.findUnique({ where: { id: listaId } });
    if (!existing) throw new HttpError(404, "Lista não encontrada.");
    const tema = normalizeBabyListTheme(req.body.tema ?? existing.tema);

    const list = await prisma.listaPresente.update({
      where: { id: listaId },
      data: { nomeBebe, dataEvento, tema },
      include: {
        cliente: { select: { id: true, nome: true, email: true, telefone: true } },
        produtos: {
          include: {
            produto: { include: { estoquesPorTamanho: { orderBy: { ordem: "asc" } } } },
          },
          orderBy: { comprado: "asc" },
        },
      },
    });
    res.json({ message: "Lista atualizada com sucesso.", lista: list });
  } catch (error) {
    errorResponse(error, res, "Erro ao atualizar a lista.");
  }
});

app.post("/listas/:listaId/produtos", requireAuth(["CLIENTE", "ADMIN"]), async (req: AuthenticatedRequest, res) => {
  try {
    const listaId = positiveInteger(req.params.listaId, "listaId");
    const produtoId = positiveInteger(req.body.produtoId, "produtoId");
    const list = await prisma.listaPresente.findUnique({ where: { id: listaId } });
    if (!list) throw new HttpError(404, "Lista não encontrada.");
    if (req.auth?.perfil === "CLIENTE" && list.clienteId !== req.auth.sub) {
      throw new HttpError(403, "Esta lista pertence a outro cliente.");
    }
    const product = await prisma.produto.findUnique({
      where: { id: produtoId },
      include: { estoquesPorTamanho: { orderBy: { ordem: "asc" } } },
    });
    if (!product) throw new HttpError(404, "Produto não encontrado.");
    const tamanho = validProductSize(req.body.tamanho, product.tamanhos);
    const sizeStock = stockForSize(product.estoquesPorTamanho, tamanho);
    if (!sizeStock || sizeStock.quantidade === 0) {
      throw new HttpError(409, `O tamanho ${tamanho} está sem estoque no momento.`);
    }
    const item = await prisma.listaPresenteProduto.upsert({
      where: { listaId_produtoId: { listaId, produtoId } },
      update: { tamanho },
      create: { listaId, produtoId, tamanho },
    });
    res.status(201).json({ message: "Produto adicionado à lista.", item });
  } catch (error) {
    errorResponse(error, res, "Erro ao adicionar o produto à lista.");
  }
});

app.delete("/listas/:listaId/produtos/:produtoId", requireAuth(["CLIENTE", "ADMIN"]), async (req: AuthenticatedRequest, res) => {
  try {
    const listaId = positiveInteger(req.params.listaId, "listaId");
    const produtoId = positiveInteger(req.params.produtoId, "produtoId");
    const list = await prisma.listaPresente.findUnique({ where: { id: listaId } });
    if (!list) throw new HttpError(404, "Lista não encontrada.");
    if (req.auth?.perfil === "CLIENTE" && list.clienteId !== req.auth.sub) {
      throw new HttpError(403, "Esta lista pertence a outro cliente.");
    }
    const giftItem = await prisma.listaPresenteProduto.findUnique({
      where: { listaId_produtoId: { listaId, produtoId } },
    });
    if (!giftItem) throw new HttpError(404, "Produto não encontrado nesta lista.");
    if (giftItem.comprado) {
      throw new HttpError(409, "Um presente já comprado não pode ser removido da lista.");
    }
    await prisma.listaPresenteProduto.delete({
      where: { listaId_produtoId: { listaId, produtoId } },
    });
    res.json({ message: "Produto removido da lista." });
  } catch (error) {
    errorResponse(error, res, "Erro ao remover o produto da lista.");
  }
});

app.get("/clientes/me/listas", requireAuth(["CLIENTE"]), async (req: AuthenticatedRequest, res) => {
  const lists = await prisma.listaPresente.findMany({
    where: { clienteId: req.auth!.sub },
    include: { produtos: { include: { produto: true } } },
    orderBy: { dataEvento: "desc" },
  });
  res.json(lists);
});

app.post("/pedidos", requireAuth(["CLIENTE"]), async (req: AuthenticatedRequest, res) => {
  let createdOrderId: number | null = null;
  try {
    if (!mercadoPagoToken) {
      throw new HttpError(503, "A integração com o Mercado Pago ainda não foi configurada.");
    }
    const client = await prisma.cliente.findUnique({ where: { id: req.auth!.sub } });
    if (!client) throw new HttpError(404, "Cliente não encontrado.");
    if (!client.cpf) throw new HttpError(400, "Cadastre o CPF antes de gerar o PIX.");

    const order = await createPendingOrder(
      client.id,
      req.body.itensCarrinho,
      "PIX",
      req.body.entrega,
    );
    createdOrderId = order.id;
    const nameParts = client.nome.trim().split(/\s+/);
    const firstName = nameParts.shift() || client.nome;
    const lastName = nameParts.join(" ") || "Cliente";
    let paymentData;
    try {
      paymentData = await payment.create({
        body: {
          transaction_amount: Number(order.valorTotal),
          description: `Pedido #${order.id} - Pegada Kids`,
          external_reference: String(order.id),
          payment_method_id: "pix",
          payer: {
            email: client.email,
            first_name: firstName,
            last_name: lastName,
            identification: { type: "CPF", number: client.cpf },
          },
        },
        requestOptions: { idempotencyKey: crypto.randomUUID() },
      });
    } catch (error) {
      console.error("Mercado Pago recusou a criação do PIX:", mercadoPagoErrorText(error));
      throw friendlyMercadoPagoError(error);
    }
    const pixCode = paymentData.point_of_interaction?.transaction_data?.qr_code;
    if (!pixCode || paymentData.id === undefined || paymentData.id === null) {
      throw new HttpError(502, "O Mercado Pago não retornou os dados do PIX.");
    }
    const updatedOrder = await prisma.pedido.update({
      where: { id: order.id },
      data: { mercadoPagoId: String(paymentData.id), qrCodePix: pixCode },
    });
    res.status(201).json({
      message: "Pedido e PIX gerados com sucesso.",
      pedidoId: updatedOrder.id,
      pixCode,
    });
  } catch (error) {
    if (createdOrderId) {
      await prisma.pedido.update({
        where: { id: createdOrderId },
        data: { status: "Falha no pagamento" },
      }).catch(() => undefined);
    }
    errorResponse(error, res, "Erro ao gerar o pagamento PIX.");
  }
});

app.post("/pedidos/whatsapp", requireAuth(["CLIENTE"]), async (req: AuthenticatedRequest, res) => {
  try {
    const order = await createPendingOrder(
      req.auth!.sub,
      req.body.itensCarrinho,
      "WHATSAPP",
      req.body.entrega,
    );
    res.status(201).json({
      message: "Pedido pendente registrado antes do redirecionamento.",
      pedidoId: order.id,
      valorTotal: Number(order.valorTotal),
    });
  } catch (error) {
    errorResponse(error, res, "Erro ao registrar o pedido do WhatsApp.");
  }
});

app.post("/pedidos/:id/simular-pagamento", requireAuth(["CLIENTE", "ADMIN"]), async (req: AuthenticatedRequest, res) => {
  try {
    if (!tccDemoMode) {
      throw new HttpError(404, "A simulação de pagamento está desativada.");
    }
    const pedidoId = positiveInteger(req.params.id, "id");
    const order = await prisma.pedido.findUnique({ where: { id: pedidoId } });
    if (!order) throw new HttpError(404, "Pedido não encontrado.");
    if (req.auth?.perfil === "CLIENTE" && order.clienteId !== req.auth.sub) {
      throw new HttpError(403, "Este pedido pertence a outro cliente.");
    }
    const result = await processApprovedOrder(pedidoId);
    res.json({
      message: result.alreadyProcessed
        ? "O pagamento já havia sido processado; nenhuma baixa foi repetida."
        : "Pagamento aprovado, estoque e lista atualizados.",
      idempotente: result.alreadyProcessed,
    });
  } catch (error) {
    errorResponse(error, res, "Erro ao simular a confirmação do pagamento.");
  }
});

app.post("/webhook", async (req, res) => {
  try {
    const paymentId = req.query.id || req.query["data.id"] || req.body?.data?.id;
    if (!paymentId) {
      res.sendStatus(200);
      return;
    }
    const paymentData = await payment.get({ id: String(paymentId) });
    if (paymentData.status === "approved" && paymentData.external_reference) {
      const pedidoId = positiveInteger(paymentData.external_reference, "pedidoId");
      const order = await prisma.pedido.findUnique({ where: { id: pedidoId } });
      if (!order) throw new HttpError(404, "Pedido do pagamento não encontrado.");
      if (order.mercadoPagoId && order.mercadoPagoId !== String(paymentData.id)) {
        throw new HttpError(409, "O pagamento não corresponde ao pedido informado.");
      }
      const paidAmount = Number(paymentData.transaction_amount);
      if (!Number.isFinite(paidAmount) || Math.abs(paidAmount - Number(order.valorTotal)) > 0.005) {
        throw new HttpError(409, "O valor confirmado não corresponde ao total do pedido.");
      }
      await processApprovedOrder(
        pedidoId,
        String(paymentData.id),
      );
    }
    res.sendStatus(200);
  } catch (error) {
    console.error("Erro ao processar o webhook; o Mercado Pago poderá reenviar.", error);
    res.sendStatus(500);
  }
});

app.get("/pedidos/me", requireAuth(["CLIENTE"]), async (req: AuthenticatedRequest, res) => {
  const orders = await prisma.pedido.findMany({
    where: { clienteId: req.auth!.sub },
    include: { itens: { include: { produto: true, listaPresente: true } } },
    orderBy: { dataCriacao: "desc" },
  });
  res.json(orders);
});

app.get("/admin/pedidos", requireAuth(["ADMIN"]), async (_req, res) => {
  const orders = await prisma.pedido.findMany({
    include: {
      cliente: { select: { id: true, nome: true, email: true } },
      itens: { include: { produto: true, listaPresente: true } },
    },
    orderBy: { dataCriacao: "desc" },
  });
  res.json(orders);
});

app.patch("/admin/pedidos/:id/status", requireAuth(["ADMIN"]), async (req, res) => {
  try {
    const pedidoId = positiveInteger(req.params.id, "id");
    const status = requiredText(req.body.status, "status");
    const allowedStatuses = [
      "Pendente",
      "Aprovado",
      "Em separação",
      "Enviado",
      "Entregue",
      "Cancelado",
      "Falha no pagamento",
    ];
    if (!allowedStatuses.includes(status)) {
      throw new HttpError(400, "Status de pedido inválido.");
    }
    const fulfillmentStatuses = ["Aprovado", "Em separação", "Enviado", "Entregue"];
    if (fulfillmentStatuses.includes(status)) {
      await processApprovedOrder(pedidoId);
      if (status !== "Aprovado") {
        await prisma.pedido.update({ where: { id: pedidoId }, data: { status } });
      }
    } else if (status === "Cancelado" || status === "Falha no pagamento") {
      await cancelProcessedOrder(pedidoId, status);
    } else {
      const order = await prisma.pedido.findUnique({ where: { id: pedidoId } });
      if (!order) throw new HttpError(404, "Pedido não encontrado.");
      if (order.processadoEm) {
        throw new HttpError(
          409,
          "Um pedido já confirmado não pode voltar para Pendente. Cancele-o para devolver o estoque.",
        );
      }
      await prisma.pedido.update({ where: { id: pedidoId }, data: { status: "Pendente" } });
    }
    res.json({ message: "Status atualizado com sucesso." });
  } catch (error) {
    errorResponse(error, res, "Erro ao atualizar o status do pedido.");
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: "Rota não encontrada." });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof SyntaxError) {
    res.status(400).json({ error: "O conteúdo enviado não é um JSON válido." });
    return;
  }
  errorResponse(error, res, "Erro interno do servidor.");
});

async function startServer() {
  await ensureAdminUser();
  app.listen(port, () => console.log(`Servidor Pegada Kids disponível em http://localhost:${port}`));
}

startServer().catch((error) => {
  console.error("Não foi possível iniciar o servidor.", error);
  process.exit(1);
});
