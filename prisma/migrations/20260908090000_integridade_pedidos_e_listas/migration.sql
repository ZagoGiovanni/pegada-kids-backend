-- Vincula cada item comprado à lista de presentes que o originou.
ALTER TABLE "ItemPedido" ADD COLUMN "listaPresenteId" INTEGER;

-- Registra a baixa do presente e o momento em que ela ocorreu.
ALTER TABLE "ListaPresenteProduto"
ADD COLUMN "comprado" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "compradoEm" TIMESTAMP(3);

-- Permite auditar quando o pedido foi processado pela primeira vez.
ALTER TABLE "Pedido" ADD COLUMN "processadoEm" TIMESTAMP(3);

CREATE INDEX "ItemPedido_listaPresenteId_idx" ON "ItemPedido"("listaPresenteId");

ALTER TABLE "ItemPedido"
ADD CONSTRAINT "ItemPedido_listaPresenteId_fkey"
FOREIGN KEY ("listaPresenteId") REFERENCES "ListaPresente"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
