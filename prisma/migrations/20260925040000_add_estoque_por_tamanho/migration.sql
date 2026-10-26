-- CreateTable
CREATE TABLE "EstoqueProdutoTamanho" (
    "produtoId" INTEGER NOT NULL,
    "tamanho" TEXT NOT NULL,
    "quantidade" INTEGER NOT NULL DEFAULT 0,
    "ordem" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "EstoqueProdutoTamanho_pkey" PRIMARY KEY ("produtoId", "tamanho")
);

-- CreateIndex
CREATE INDEX "EstoqueProdutoTamanho_produtoId_idx" ON "EstoqueProdutoTamanho"("produtoId");

-- AddForeignKey
ALTER TABLE "EstoqueProdutoTamanho"
ADD CONSTRAINT "EstoqueProdutoTamanho_produtoId_fkey"
FOREIGN KEY ("produtoId") REFERENCES "Produto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Os produtos antigos tinham apenas um total. Para preservar esse total,
-- ele é distribuído entre os tamanhos cadastrados, na ordem em que aparecem.
WITH tamanhos AS (
    SELECT
        produto."id" AS produto_id,
        BTRIM(item.tamanho) AS tamanho,
        produto."quantidadeEstoque" AS total,
        ROW_NUMBER() OVER (PARTITION BY produto."id" ORDER BY item.ordem) AS posicao,
        COUNT(*) OVER (PARTITION BY produto."id") AS quantidade_tamanhos
    FROM "Produto" AS produto
    CROSS JOIN LATERAL UNNEST(
        STRING_TO_ARRAY(COALESCE(NULLIF(BTRIM(produto."tamanhos"), ''), 'Único'), ',')
    ) WITH ORDINALITY AS item(tamanho, ordem)
    WHERE BTRIM(item.tamanho) <> ''
)
INSERT INTO "EstoqueProdutoTamanho" ("produtoId", "tamanho", "quantidade", "ordem")
SELECT
    produto_id,
    tamanho,
    FLOOR(total::NUMERIC / quantidade_tamanhos)::INTEGER
        + CASE WHEN posicao <= (total % quantidade_tamanhos) THEN 1 ELSE 0 END,
    (posicao - 1)::INTEGER
FROM tamanhos;
