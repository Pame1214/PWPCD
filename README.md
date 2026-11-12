# PWPCD

O mesmo Cloudflare Worker serve as páginas, os arquivos estáticos e a API. Os usuários, as sessões e os registros ficam no PostgreSQL do Neon. As categorias continuam abertas para visitantes.

## Preparar o banco

1. Abra o **SQL Editor** do projeto Neon, selecione o branch e banco que o Worker usará e execute [debug/schema.sql](debug/schema.sql) com a role proprietária. O script pode ser executado novamente e preserva as contas e os registros que já existem.
2. Em **Connect**, copie a URL PostgreSQL da role que o Worker usará. Se for usar a role existente `PWPCD Acesso`, rode também os comandos abaixo como proprietário. Para outra role, troque o nome depois de `TO` em cada linha.

```sql
GRANT USAGE ON SCHEMA public TO "PWPCD Acesso";
GRANT SELECT, INSERT ON public.app_users TO "PWPCD Acesso";
GRANT UPDATE (password_hash, legacy_password) ON public.app_users TO "PWPCD Acesso";
GRANT SELECT, INSERT, DELETE ON public.app_sessions TO "PWPCD Acesso";
GRANT SELECT, INSERT ON public.debug_registros TO "PWPCD Acesso";
GRANT USAGE ON SEQUENCE public.app_users_id_seq, public.debug_registros_id_seq TO "PWPCD Acesso";
```

## Publicar no Cloudflare

Com Node.js 22 ou mais recente, execute na raiz do repositório.

```sh
npm ci
npm run check
npx wrangler login
npx wrangler secret put DATABASE_URL
npm run deploy
```

Cole a URL do Neon no prompt do Wrangler. Abra o endereço `https://pwpcd.<seu-subdominio>.workers.dev` mostrado no fim do deploy.

Se o Worker já estiver ligado ao GitHub em **Workers & Pages**, use `npm run deploy` como comando de deploy, com a raiz do repositório como diretório. Configure `DATABASE_URL` como **Secret** em **Settings → Variables and Secrets** do Worker. Use o mesmo nome `pwpcd` no painel e em `wrangler.jsonc`. Para builds de preview pelo GitHub, defina também `npm run build:static` como comando de build.

## Testar localmente

Copie [.dev.vars.example](.dev.vars.example) para `.dev.vars` e preencha `DATABASE_URL` com a URL de um branch Neon de teste. Aplique o mesmo esquema nesse branch.

```sh
npm ci
npm run preview
```

Abra `http://localhost:8787`. O Wrangler executa o Worker e serve os mesmos arquivos usados no deploy.

## Painel de diagnóstico

Para habilitar `/debug/`, adicione `PWPCD_ADMIN_TOKEN` como um segundo **Secret** com uma chave aleatória de pelo menos 32 caracteres. Digite a chave no painel para ler, gravar, atualizar ou excluir registros. Para editar e excluir usando a role `PWPCD Acesso`, conceda também as duas permissões abaixo.

```sql
GRANT UPDATE (mensagem, origem) ON public.debug_registros TO "PWPCD Acesso";
GRANT DELETE ON public.debug_registros TO "PWPCD Acesso";
```

## Checklist de publicação

- [ ] Executar `debug/schema.sql` no banco e branch corretos do Neon.
- [ ] Gravar `DATABASE_URL` como Secret do Worker `pwpcd`.
- [ ] Executar `npm run check` e `npm run deploy` ou publicar via Workers Builds.
- [ ] Abrir o endereço publicado e confirmar que `/api/health` retorna `{"ok":true}`.
- [ ] Abrir **Categorias** sem login e testar um dos artigos.
- [ ] Criar uma conta de teste, navegar entre páginas e conferir se o usuário continua conectado após recarregar.
- [ ] Voltar ao início, salvar um registro de teste e confirmar a mensagem de sucesso.
- [ ] Sair, entrar com a mesma conta e confirmar que o login volta a funcionar. Ao sair, uma nova tentativa de salvar deve pedir login.
- [ ] Se habilitar `/debug/`, confirmar que a chave permite ler, atualizar e excluir o registro de teste.
- [ ] Se o repositório ainda publicar uma cópia antiga no GitHub Pages, desativá-la em **Settings → Pages** após validar o Worker.
