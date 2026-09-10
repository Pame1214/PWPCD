# PWPCD

## Hospedagem

O GitHub Pages publica a parte estática do projeto, mas não executa o Node nem acessa o PostgreSQL. O deploy fica disponível em:

```text
https://SEU_USUARIO.github.io/NOME_DO_REPOSITORIO/
```

Para login e CRUD, hospede `debug/server.js` em Render, Railway ou Koyeb e configure a URL pública do backend antes do `Js/js_idx.js` ser carregado:

```html
<script>
	window.PWPCD_API_BASE = "https://seu-backend.example.com";
</script>
<script src="Js/js_idx.js"></script>
```

Nunca coloque `senha`, `DATABASE_URL` ou qualquer connection string no GitHub Pages. O banco deve ser acessado somente pelo backend.

## GitHub Pages

No repositório, abra **Settings > Pages**, selecione **GitHub Actions** e faça push. O workflow em `.github/workflows/pages.yml` publica os arquivos estáticos automaticamente.