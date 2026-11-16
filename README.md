# Sistema Financeiro Multicloud — Trabalho Fatec

SaaS de projeção de investimentos em que cada cálculo roda numa FaaS serverless de uma nuvem pública diferente, com fallback isolado (*graceful degradation*).

Fatec Itapira · Computação em Nuvem I · Atividade Prática 04 · Grupo A

## Arquitetura

```
web/index.html ──POST──▶ AWS Lambda        juros compostos  → montanteBruto, histórico
        │                     │ montanteBruto
        ├──POST──▶ Azure Functions   câmbio BRL → USD/EUR
        └──POST──▶ Google Cloud      inflação (IPCA) → valor real
```

A AWS roda primeiro; Azure e GCP recebem o montante dela e rodam em paralelo.
Se uma nuvem falha (rede, timeout ou HTTP 5xx), o navegador calcula o mesmo resultado
localmente e o card mostra **Fallback Local** com o status HTTP real. Erros **400**
(entrada inválida) são exibidos como estão, sem fallback.

| Pasta | Função | Entrada (POST JSON) |
|---|---|---|
| `aws-lambda/` | `handler` | `aporteInicial`, `aporteMensal`, `taxaJuros` (% a.m., 0–100), `tempoMeses` (1–600) |
| `azure-functions/conversorCambio/` | `conversorCambio` | `montanteBRL` (≥ 0) |
| `google-functions/` | `projetorInflacao` | `montanteBruto` (> 0), `totalInvestido`, `taxaInflacao` (% a.a., −10–100), `tempoMeses` |

Todas seguem o mesmo contrato:

- `200` → `{ status: "success", provider, coldStart, data }`
- `400` → `{ status: "error", erro: "VALIDACAO", detalhes: [{ campo, mensagem }] }`
- `500` → `{ status: "error", erro: "INTERNO", mensagem }`; `?simularErro=true` força esse caso (usado pelas caixas "Forçar Falha" do site)

Convenção financeira: aportes mensais feitos no **fim** de cada mês.

## Deploy

- **AWS Lambda** (Node.js 22): publicar `aws-lambda/index.js`, handler `index.handler`. Na Function URL, usar *Auth type* `NONE`, com a política de recurso permitindo `lambda:InvokeFunctionUrl` **e** `lambda:InvokeFunction` para o principal `*`.
- **Azure Functions** (Node.js 22, modelo com `function.json`): publicar a pasta `azure-functions/` inteira (o `host.json` fica na raiz dela). A URL fica `https://<app>.azurewebsites.net/api/conversorCambio`.
- **Google Cloud** (Node.js 22): `gcloud functions deploy projetorInflacao --gen2 --runtime=nodejs22 --trigger-http --allow-unauthenticated --source=google-functions`.
- **Site**: `web/` é estático (ex.: Vercel). As URLs ficam no objeto `endpoints` do `web/index.html` ou podem ser trocadas pela engrenagem da página. Campo vazio = cálculo local.

## Testes

```bash
npm install                      # jsdom (testes do front-end)
npm install --prefix google-functions
npm test
```

- `tests/backends.test.mjs`: cálculos, validação 400, `simularErro` 500, CORS/OPTIONS das três funções.
- `tests/paridade.test.mjs`: o cálculo local do navegador precisa dar exatamente o mesmo resultado das funções.
- `tests/frontend.test.mjs`: roda a página no jsdom com as funções reais por trás e cobre cascata, fallback, erros 400, modo mock, gráfico e descarte de execuções antigas.
