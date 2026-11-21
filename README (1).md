# VESTRA AI

Estrutura do repositório (tudo na raiz):

```
servidor.js        backend (Express + Supabase + Hotmart + FASHN) - também entrega o site
index.html         site da VESTRA AI (todos os módulos)
001_vestra.sql     banco do Supabase (rodar UMA vez no SQL Editor; não é usado pelo Render)
package.json       dependências e comando de início
.gitignore
.env.example       modelo das variáveis (NÃO coloque segredos aqui)
README.md
```

O `servidor.js` procura o `index.html` na mesma pasta (ou em `public/`) e entrega apenas esse arquivo.
A raiz do repositório nunca é exposta publicamente.

## Render (Web Service)

| Campo | Valor |
|---|---|
| Runtime | Node |
| Root Directory | (vazio) |
| Build Command | `npm install` |
| Start Command | `npm start` (executa `node servidor.js`) |
| Health Check Path | `/healthz` |
| Instance Type | Starter ou superior (recomendado, veja a observação abaixo) |

Environment (painel do Render): `NODE_ENV=production`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`,
`HOTMART_HOTTOK`, `FASHN_API_KEY`, `CREDITS_ROLLOVER=false`. Não defina `PORT`.

Observação: no plano gratuito o Render suspende o serviço por inatividade. Isso atrasa o site e pode
atrasar respostas ao webhook da Hotmart e o acompanhamento das gerações. Para cobrar clientes, use instância paga.

## Depois do deploy
1. Abra `https://SEU-SERVICO.onrender.com/healthz`: deve mostrar `ok`.
2. Abra `/api/config`: deve mostrar `{"payments":...,"tryon":...}` (true quando a variável está definida).
3. Abra `/`: deve aparecer o site. Conta > deve exibir o login do Supabase.
4. Supabase > Authentication > URL Configuration: Site URL e Redirect URLs = a URL do Render (ou seu domínio).
5. Hotmart > Webhook: `https://SEU-SERVICO.onrender.com/api/webhooks/hotmart`.
6. Supabase > tabela `plans`: preencher `hotmart_offer_code` e `checkout_url`.

Se o serviço não iniciar, veja Logs no Render: o servidor encerra com a mensagem
"Variável de ambiente ausente: NOME" quando falta alguma obrigatória (`SUPABASE_URL`, `SUPABASE_SECRET_KEY`).
