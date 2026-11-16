// Função 2 (Azure): Conversor de Câmbio BRL -> USD / EUR
// POST { montanteBRL }
// 200 = sucesso | 400 = parâmetros inválidos | 500 = falha interna (?simularErro=true força)

const PROVIDER = "Azure Functions (brazilsouth)";

// Cotações pré-definidas para fins acadêmicos
const COTACAO_USD = 5.60;
const COTACAO_EUR = 6.10;

// Fica true só na primeira invocação de cada instância (cold start real)
let coldStart = true;

const arredondar = (n) => Math.round(n * 100) / 100;

function lerCorpo(req) {
    if (req.body && typeof req.body === "object") return req.body;
    if (typeof req.body === "string" && req.body.trim() !== "") return JSON.parse(req.body);
    return {};
}

module.exports = async function (context, req) {
    const eraColdStart = coldStart;
    coldStart = false;

    const requestId = (req.headers && req.headers["x-request-id"]) || null;
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, X-Request-Id",
        "Access-Control-Allow-Methods": "OPTIONS,POST",
        "Content-Type": "application/json"
    };
    const responder = (status, body) => { context.res = { status, headers, body }; };

    if (req.method === "OPTIONS") {
        responder(204, "");
        return;
    }

    if (req.method !== "POST") {
        responder(400, {
            status: "error",
            erro: "VALIDACAO",
            detalhes: [{ campo: "method", mensagem: "use POST com corpo JSON" }],
            requestId
        });
        return;
    }

    try {
        // Demonstração de resiliência: força uma falha interna
        if (req.query && req.query.simularErro === "true") {
            throw new Error("Falha simulada (simularErro=true)");
        }

        let body;
        try {
            body = lerCorpo(req);
        } catch {
            responder(400, {
                status: "error",
                erro: "VALIDACAO",
                detalhes: [{ campo: "body", mensagem: "JSON inválido" }],
                requestId
            });
            return;
        }

        const valor = body.montanteBRL;
        const montanteBRL = (valor === undefined || valor === null || valor === "") ? undefined : Number(valor);
        const detalhes = [];
        if (montanteBRL === undefined) {
            detalhes.push({ campo: "montanteBRL", mensagem: "é obrigatório" });
        } else if (!Number.isFinite(montanteBRL) || montanteBRL < 0) {
            detalhes.push({ campo: "montanteBRL", mensagem: "deve ser um número maior ou igual a 0" });
        }
        if (detalhes.length > 0) {
            responder(400, { status: "error", erro: "VALIDACAO", detalhes, requestId });
            return;
        }

        responder(200, {
            status: "success",
            provider: PROVIDER,
            coldStart: eraColdStart,
            data: {
                valorBRL: arredondar(montanteBRL),
                valorUSD: arredondar(montanteBRL / COTACAO_USD),
                valorEUR: arredondar(montanteBRL / COTACAO_EUR),
                cotacaoUSD: COTACAO_USD,
                cotacaoEUR: COTACAO_EUR
            },
            requestId
        });
    } catch (error) {
        context.log.error("[conversorCambio]", requestId, error);
        responder(500, { status: "error", erro: "INTERNO", mensagem: error.message, requestId });
    }
};
