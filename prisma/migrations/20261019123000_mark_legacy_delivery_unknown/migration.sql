-- Pedidos antigos do WhatsApp não guardavam a forma de recebimento.
-- Mantém o histórico honesto em vez de classificá-los automaticamente como retirada.
ALTER TABLE "Pedido" DROP CONSTRAINT "Pedido_tipoEntrega_check";

UPDATE "Pedido"
SET "tipoEntrega" = 'NAO_INFORMADO'
WHERE "metodoPagamento" = 'WHATSAPP'
  AND "cepEntrega" IS NULL;

ALTER TABLE "Pedido"
ADD CONSTRAINT "Pedido_tipoEntrega_check"
CHECK ("tipoEntrega" IN ('RETIRADA', 'ENTREGA', 'NAO_INFORMADO'));
