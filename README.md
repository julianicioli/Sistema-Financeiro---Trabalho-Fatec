# SaaS Financeiro Multicloud - Grupo A

Trabalho da Atividade Prática 04 de Computação em Nuvem I (Fatec Itapira, Prof. Reginaldo).

A ideia é simular um investimento: o usuário preenche aporte inicial, aporte mensal, taxa, tempo e inflação, e o site mostra o resultado calculado por três funções serverless, uma em cada nuvem.

## Integrantes

- João Lucas Altafini
- Julia Nicioli
- João Gabriel Moimaz
- Luan Trani

## Links

Site: https://saas-financeiro-grupo-a.vercel.app

Funções (todas recebem `POST` com JSON):

| Nuvem | Função | URL |
|---|---|---|
| AWS Lambda | Juros compostos | https://hfzju3c5szs6sminjuri4tpgwi0mzgnh.lambda-url.sa-east-1.on.aws/ |
| Azure Functions | Conversão de câmbio (BRL para USD e EUR) | https://conversorlegal-adfuh2h0fdf0ajdx.canadacentral-01.azurewebsites.net/api/cambio |
| Google Cloud | Inflação e poder de compra (IPCA) | https://inflacao-20304353773.us-central1.run.app |

## Como funciona

```
Usuário -> Site (Vercel) -> AWS (calcula o montante)
                         -> Azure e Google Cloud (em paralelo, usando o montante da AWS)
```

O site chama a AWS primeiro e depois a Azure e o Google Cloud ao mesmo tempo. Se alguma nuvem falhar ou demorar mais de 4 segundos, só aquele card mostra "Serviço Temporariamente Indisponível" e o valor é calculado no próprio navegador. Os outros cards continuam normais.

As funções respondem 200 quando dá certo, 400 quando algum dado é inválido e 500 em caso de erro. Os detalhes de cada endpoint (entradas, saídas e exemplos) estão no documento técnico em PDF.

## Como testar

Pelo site:

1. Abra o link do site e clique em "Executar Projeção Multicloud".
2. Os três cards devem mostrar "200 OK" e o tempo de resposta de cada nuvem.
3. Para testar a falha, marque "Simular falha" em uma das nuvens e execute de novo. Só aquele card cai para o cálculo local.
4. O painel de métricas no fim da página mostra o tempo de cada chamada e permite exportar em CSV.

Direto na função (exemplo com a AWS):

```bash
curl -X POST https://hfzju3c5szs6sminjuri4tpgwi0mzgnh.lambda-url.sa-east-1.on.aws/ \
  -H "Content-Type: application/json" \
  -d '{"aporteInicial":1000,"aporteMensal":200,"taxaJuros":12,"tipoTaxa":"anual","tempoMeses":24}'
```

Adicionando `?simularErro=true` no final da URL, a função devolve erro 500 (usamos isso na apresentação).

Para rodar o site no computador:

```bash
cd frontend-app
npx http-server -p 5173
```

## Testes automatizados

```bash
npm install
npm install --prefix google-functions
npm install --prefix azure-functions
npm test
```

Os testes rodam as três funções localmente (cálculo, erros 400 e 500, CORS), conferem se o cálculo de reserva do site dá o mesmo resultado das funções e abrem o site num navegador simulado para testar a cascata, o fallback e o painel de métricas.

## Estrutura

```
aws-lambda/        função da AWS
azure-functions/   função da Azure
google-functions/  função do Google Cloud
frontend-app/      site (index.html)
docs/              documento técnico
tests/             testes automatizados
```
