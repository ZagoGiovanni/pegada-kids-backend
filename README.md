# Pegada Kids - Back-end

API da plataforma web Pegada Kids, desenvolvida como Trabalho de Conclusão de Curso em Análise e Desenvolvimento de Sistemas.

O back-end concentra as regras de negócio da loja, autenticação, clientes, catálogo de produtos, estoque por tamanho, pedidos, listas de presentes de chá de bebê e integração de pagamentos Pix com o Mercado Pago.

## Tecnologias

- Node.js e TypeScript
- Express
- Prisma ORM
- PostgreSQL
- SDK do Mercado Pago

## Requisitos

- Node.js
- PostgreSQL
- npm

## Configuração

1. Instale as dependências:

   ```bash
   npm install
   ```

2. Copie `.env.example` para `.env` e preencha as configurações locais.

3. Gere o cliente do Prisma e aplique as migrações:

   ```bash
   npm run db:generate
   npm run db:migrate
   ```

4. Execute em desenvolvimento:

   ```bash
   npm run dev:watch
   ```

O servidor ficará disponível, por padrão, em `http://localhost:3333`.

## Execução de produção local

```bash
npm run build
npm start
```

## Verificação

```bash
npm test
```

## Segurança

Credenciais, tokens, senhas e dados do banco permanecem apenas no arquivo `.env`, que não é versionado. O arquivo `.env.example` contém somente valores ilustrativos.
