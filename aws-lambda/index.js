exports.handler = async (event) => {
    // Configuração de CORS para requisições HTTP REST
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
        "Content-Type": "application/json"
    };

    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers, body: "" };
    }

    try {
        const body = JSON.parse(event.body || "{}");
        const pInicial = parseFloat(body.aporteInicial) || 0;
        const pMensal = parseFloat(body.aporteMensal) || 0;
        const taxaJuros = parseFloat(body.taxaJuros) || 0;
        const tempoMeses = parseInt(body.tempoMeses) || 12;

        let totalInvestido = pInicial + (pMensal * tempoMeses);
        let i = taxaJuros / 100;
        let montanteBruto = pInicial * Math.pow(1 + i, tempoMeses);
        
        let historico = [pInicial];
        let acumulado = pInicial;

        for (let m = 1; m <= tempoMeses; m++) {
            montanteBruto += pMensal * Math.pow(1 + i, tempoMeses - m);
            acumulado = (acumulado + pMensal) * (1 + i);
            historico.push(Math.round(acumulado * 100) / 100);
        }

        let rendimentos = montanteBruto - totalInvestido;

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                status: "success",
                provider: "AWS Lambda (us-east-1)",
                data: {
                    montanteBruto: Math.round(montanteBruto * 100) / 100,
                    totalInvestido: Math.round(totalInvestido * 100) / 100,
                    totalRendimentos: Math.round(rendimentos * 100) / 100,
                    historicoEvolucao: historico
                }
            })
        };
    } catch (error) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ status: "error", message: error.message })
        };
    }
};