UPDATE "ListaPresenteProduto" AS lista_item
SET "tamanho" = COALESCE(NULLIF(TRIM(SPLIT_PART(produto."tamanhos", ',', 1)), ''), 'Único')
FROM "Produto" AS produto
WHERE lista_item."produtoId" = produto."id"
  AND lista_item."tamanho" IS NULL;

UPDATE "ItemPedido" AS pedido_item
SET "tamanho" = COALESCE(NULLIF(TRIM(SPLIT_PART(produto."tamanhos", ',', 1)), ''), 'Único')
FROM "Produto" AS produto
WHERE pedido_item."produtoId" = produto."id"
  AND pedido_item."tamanho" IS NULL;
