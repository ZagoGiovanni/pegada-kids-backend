/*
  Warnings:

  - A unique constraint covering the columns `[cpf]` on the table `Cliente` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[mercadoPagoId]` on the table `Pedido` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `senha` to the `Cliente` table without a default value. This is not possible if the table is not empty.
  - Made the column `email` on table `Cliente` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "Cliente" ADD COLUMN     "bairro" TEXT,
ADD COLUMN     "cep" TEXT,
ADD COLUMN     "cidade" TEXT DEFAULT 'Paraguaçu Paulista',
ADD COLUMN     "cpf" TEXT,
ADD COLUMN     "estado" TEXT DEFAULT 'SP',
ADD COLUMN     "numero" TEXT,
ADD COLUMN     "rua" TEXT,
ADD COLUMN     "senha" TEXT NOT NULL,
ALTER COLUMN "email" SET NOT NULL;

-- AlterTable
ALTER TABLE "Pedido" ADD COLUMN     "mercadoPagoId" TEXT,
ADD COLUMN     "metodoPagamento" TEXT,
ADD COLUMN     "qrCodePix" TEXT,
ALTER COLUMN "status" SET DEFAULT 'Pendente';

-- AlterTable
ALTER TABLE "Produto" ADD COLUMN     "categoria" TEXT DEFAULT 'Geral',
ADD COLUMN     "imagemUrl" TEXT,
ADD COLUMN     "tamanhos" TEXT DEFAULT 'Único';

-- CreateIndex
CREATE UNIQUE INDEX "Cliente_cpf_key" ON "Cliente"("cpf");

-- CreateIndex
CREATE UNIQUE INDEX "Pedido_mercadoPagoId_key" ON "Pedido"("mercadoPagoId");
