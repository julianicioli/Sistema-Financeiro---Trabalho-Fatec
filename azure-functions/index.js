module.exports = async function (context, req) {
    context.res = {
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
            "Content-Type": "application/json"
        }
    };

    if (req.method === "OPTIONS") {
        context.res.status = 200;
        context.res.body = "";
        return;
    }

    try {
        const body = req.body || {};
        const montanteBRL = parseFloat(body.montanteBRL) || 0;

        // Cotações pré-definidas ou simuladas para fins acadêmicos
        const taxaUSD = 5.60;
        const taxaEUR = 6.10;

        const valorUSD = Math.round((montanteBRL / taxaUSD) * 100) / 100;
        const valorEUR = Math.round((montanteBRL / taxaEUR) * 100) / 100;

        context.res.status = 200;
        context.res.body = {
            status: "success",
            provider: "Azure Functions (brazilsouth)",
            data: {
                valorBRL: montanteBRL,
                valorUSD: valorUSD,
                valorEUR: valorEUR,
                cotacaoUSD: taxaUSD,
                cotacaoEUR: taxaEUR
            }
        };
    } catch (error) {
        context.res.status = 400;
        context.res.body = { status: "error", message: error.message };
    }
};