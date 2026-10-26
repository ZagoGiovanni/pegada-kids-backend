-- CreateTable
CREATE TABLE "RecuperacaoSenha" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "perfil" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiraEm" TIMESTAMP(3) NOT NULL,
    "usadoEm" TIMESTAMP(3),
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecuperacaoSenha_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecuperacaoSenha_tokenHash_key" ON "RecuperacaoSenha"("tokenHash");

-- CreateIndex
CREATE INDEX "RecuperacaoSenha_email_perfil_idx" ON "RecuperacaoSenha"("email", "perfil");

-- CreateIndex
CREATE INDEX "RecuperacaoSenha_expiraEm_idx" ON "RecuperacaoSenha"("expiraEm");
