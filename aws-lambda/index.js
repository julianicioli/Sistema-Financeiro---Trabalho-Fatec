// Função 1 (AWS): Calculadora de Juros Compostos
// POST { aporteInicial, aporteMensal, taxaJuros (% ao mês), tempoMeses }
// Convenção: aportes mensais feitos no FIM de cada mês.
// 200 = sucesso | 400 = parâmetros inválidos | 500 = falha interna (?simularErro=true força)

const PROVIDER = "AWS Lambda (sa-east-1)";

// Fica true só na primeira invocação de cada instância (cold start real)
let coldStart = true;

const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Request-Id",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
    "Content-Type": "application/json"
};

const arredondar = (n) => Math.round(n * 100) / 100;

function resposta(statusCode, corpo) {
    return { statusCode, headers, body: JSON.stringify(corpo) };
}

function lerNumero(body, campo) {
    const valor = body[campo];
    if (valor === undefined || valor === null || valor === "") return undefined;
    return Number(valor);
}

function validar(body) {
    const detalhes = [];
    const aporteInicial = lerNumero(body, "aporteInicial") ?? 0;
    const aporteMensal = lerNumero(body, "aporteMensal") ?? 0;
    const taxaJuros = lerNumero(body, "taxaJuros");
    const tempoMeses = lerNumero(body, "tempoMeses");

    if (!Number.isFinite(aporteInicial) || aporteInicial < 0) {
        detalhes.push({ campo: "aporteInicial", mensagem: "deve ser um número maior ou igual a 0" });
    }
    if (!Number.isFinite(aporteMensal) || aporteMensal < 0) {
        detalhes.push({ campo: "aporteMensal", mensagem: "deve ser um número maior ou igual a 0" });
    }
    if (taxaJuros === undefined) {
        detalhes.push({ campo: "taxaJuros", mensagem: "é obrigatório" });
    } else if (!Number.isFinite(taxaJuros) || taxaJuros < 0 || taxaJuros > 100) {
        detalhes.push({ campo: "taxaJuros", mensagem: "deve estar entre 0 e 100 (% ao mês)" });
    }
    if (tempoMeses === undefined) {
        detalhes.push({ campo: "tempoMeses", mensagem: "é obrigatório" });
    } else if (!Number.isInteger(tempoMeses) || tempoMeses < 1 || tempoMeses > 600) {
        detalhes.push({ campo: "tempoMeses", mensagem: "deve ser um inteiro entre 1 e 600" });
    }

    return { detalhes, aporteInicial, aporteMensal, taxaJuros, tempoMeses };
}

function calcularJurosCompostos(aporteInicial, aporteMensal, taxaJuros, tempoMeses) {
    const i = taxaJuros / 100;
    const historico = [arredondar(aporteInicial)];
    let acumulado = aporteInicial;

    for (let m = 1; m <= tempoMeses; m++) {
        acumulado = acumulado * (1 + i) + aporteMensal;
        historico.push(arredondar(acumulado));
    }

    const totalInvestido = aporteInicial + aporteMensal * tempoMeses;
    return {
        montanteBruto: arredondar(acumulado),
        totalInvestido: arredondar(totalInvestido),
        totalRendimentos: arredondar(acumulado - totalInvestido),
        historicoEvolucao: historico
    };
}

exports.handler = async (event = {}) => {
    const eraColdStart = coldStart;
    coldStart = false;

    // Function URL / API Gateway HTTP API (payload 2.0) ou API Gateway REST (payload 1.0)
    const metodo = event.requestContext?.http?.method || event.httpMethod || "POST";
    // A Function URL só libera o header Content-Type no CORS, então o front também manda o requestId no corpo
    let requestId = event.headers?.["x-request-id"] || event.headers?.["X-Request-Id"] || null;

    if (metodo === "OPTIONS") {
        return { statusCode: 204, headers, body: "" };
    }

    if (metodo !== "POST") {
        return resposta(400, {
            status: "error",
            erro: "VALIDACAO",
            detalhes: [{ campo: "method", mensagem: "use POST com corpo JSON" }],
            requestId
        });
    }

    try {
        // Demonstração de resiliência: força uma falha interna
        if (event.queryStringParameters?.simularErro === "true") {
            throw new Error("Falha simulada (simularErro=true)");
        }

        let body;
        try {
            const bruto = event.isBase64Encoded
                ? Buffer.from(event.body || "", "base64").toString("utf8")
                : event.body;
            body = typeof bruto === "string" ? JSON.parse(bruto || "{}") : (bruto || {});
        } catch {
            return resposta(400, {
                status: "error",
                erro: "VALIDACAO",
                detalhes: [{ campo: "body", mensagem: "JSON inválido" }],
                requestId
            });
        }

        if (!requestId && typeof body?.requestId === "string") {
            requestId = body.requestId.slice(0, 64);
        }

        const { detalhes, aporteInicial, aporteMensal, taxaJuros, tempoMeses } = validar(body || {});
        if (detalhes.length > 0) {
            return resposta(400, { status: "error", erro: "VALIDACAO", detalhes, requestId });
        }

        return resposta(200, {
            status: "success",
            provider: PROVIDER,
            coldStart: eraColdStart,
            data: calcularJurosCompostos(aporteInicial, aporteMensal, taxaJuros, tempoMeses),
            requestId
        });
    } catch (error) {
        console.error("[jurosCompostos]", requestId, error);
        return resposta(500, { status: "error", erro: "INTERNO", mensagem: error.message, requestId });
    }
};
