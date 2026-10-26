import "dotenv/config";
import { hashPassword, isPasswordHash } from "./auth";
import { prisma } from "./prisma";

async function migrateLegacyPasswords() {
  const [administrators, clients] = await Promise.all([
    prisma.usuario.findMany({ select: { id: true, senha: true } }),
    prisma.cliente.findMany({ select: { id: true, senha: true } }),
  ]);

  const legacyAdministrators = administrators.filter(
    (administrator) => !isPasswordHash(administrator.senha),
  );
  const legacyClients = clients.filter((client) => !isPasswordHash(client.senha));

  const updates = [
    ...legacyAdministrators.map((administrator) =>
      prisma.usuario.update({
        where: { id: administrator.id },
        data: { senha: hashPassword(administrator.senha) },
      }),
    ),
    ...legacyClients.map((client) =>
      prisma.cliente.update({
        where: { id: client.id },
        data: { senha: hashPassword(client.senha) },
      }),
    ),
  ];

  if (updates.length > 0) {
    await prisma.$transaction(updates);
  }

  console.log(
    `Migração concluída: ${legacyAdministrators.length} administrador(es) e ${legacyClients.length} cliente(s) protegidos com hash.`,
  );
}

migrateLegacyPasswords()
  .catch((error) => {
    console.error("Não foi possível migrar as senhas legadas.", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
