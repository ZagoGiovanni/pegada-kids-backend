-- Registra a forma de recebimento e preserva o endereço usado em cada pedido.
ALTER TABLE "Pedido"
ADD COLUMN "tipoEntrega" TEXT NOT NULL DEFAULT 'RETIRADA',
ADD COLUMN "cepEntrega" TEXT,
ADD COLUMN "ruaEntrega" TEXT,
ADD COLUMN "numeroEntrega" TEXT,
ADD COLUMN "bairroEntrega" TEXT,
ADD COLUMN "cidadeEntrega" TEXT,
ADD COLUMN "estadoEntrega" TEXT;

ALTER TABLE "Pedido"
ADD CONSTRAINT "Pedido_tipoEntrega_check"
CHECK ("tipoEntrega" IN ('RETIRADA', 'ENTREGA'));
