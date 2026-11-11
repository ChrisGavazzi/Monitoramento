// Telegram webhook - versão Kestrel (baseado no script oficial do Zabbix)
// Mudanças em relação ao oficial:
//  1. Escape HTML também trata '&' solto e '<' seguido de letra que não seja tag permitida
//     (antes, um erro com esses caracteres fazia o Telegram rejeitar a mensagem = alerta perdido).
//  2. ParseMode ausente não quebra mais o script.
//  3. Subject vazio não gera linha em branco no topo.
//  4. Resposta não-JSON da API não mascara o erro real.
//  5. Modo silencioso: severidade abaixo de SilentBelow chega sem som/vibração.
//     Parâmetros novos no media type: Severity = {EVENT.NSEVERITY}, SilentBelow = 4 (High).
//     Sem esses parâmetros, tudo chega com notificação normal (comportamento antigo).

var Telegram = {
    token: null,
    to: null,
    message: null,
    proxy: null,
    parse_mode: null,
    silent: false,

    // Tags que o Telegram aceita em parse_mode HTML. Qualquer outro '<' é escapado.
    allowedTags: /^<\/?(b|strong|i|em|u|ins|s|strike|del|a|code|pre|tg-spoiler|span|blockquote)(\s[^<>]*)?>/i,

    escapeHtml: function (str) {
        var out = '', i = 0, m;

        while (i < str.length) {
            var ch = str.charAt(i);

            if (ch === '<') {
                m = str.substring(i).match(Telegram.allowedTags);
                if (m) {
                    out += m[0];
                    i += m[0].length;
                    continue;
                }
                out += '&lt;';
            }
            else if (ch === '>') {
                out += '&gt;';
            }
            else if (ch === '&') {
                // Mantém entidades já escritas no template (ex.: &amp; na URL)
                m = str.substring(i).match(/^&(amp|lt|gt|quot|#\d+|#x[0-9a-f]+);/i);
                if (m) {
                    out += m[0];
                    i += m[0].length;
                    continue;
                }
                out += '&amp;';
            }
            else {
                out += ch;
            }
            i++;
        }

        return out;
    },

    escapeMarkup: function (str, mode) {
        switch (mode) {
            case 'markdown':
                return str.replace(/([_*\[`])/g, '\\$&');

            case 'markdownv2':
                return str.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$&');

            case 'html':
                return Telegram.escapeHtml(str);

            default:
                return str;
        }
    },

    sendMessage: function () {
        var params = {
            chat_id: Telegram.to,
            text: Telegram.message,
            disable_web_page_preview: true,
            disable_notification: Telegram.silent
        },
        data,
        response,
        request = new HttpRequest(),
        url = 'https://api.telegram.org/bot' + Telegram.token + '/sendMessage';

        if (Telegram.parse_mode !== null) {
            params['parse_mode'] = Telegram.parse_mode;
        }

        if (Telegram.proxy) {
            request.setProxy(Telegram.proxy);
        }

        request.addHeader('Content-Type: application/json');
        data = JSON.stringify(params);

        Zabbix.log(4, '[Telegram Webhook] URL: ' + url.replace(Telegram.token, '<TOKEN>'));
        Zabbix.log(4, '[Telegram Webhook] params: ' + data);
        response = request.post(url, data);
        Zabbix.log(4, '[Telegram Webhook] HTTP code: ' + request.getStatus());

        try {
            response = JSON.parse(response);
        }
        catch (error) {
            response = null;
        }

        if (request.getStatus() !== 200 || response === null || response.ok !== true) {
            if (response !== null && typeof response.description === 'string') {
                throw response.description;
            }
            throw 'HTTP ' + request.getStatus() + ', resposta inválida da API. Veja o debug log.';
        }
    }
};

try {
    var params = JSON.parse(value);

    if (typeof params.Token === 'undefined' || params.Token === '') {
        throw 'Incorrect value is given for parameter "Token": parameter is missing';
    }

    Telegram.token = params.Token;
    Telegram.to = params.To;

    if (params.HTTPProxy) {
        Telegram.proxy = params.HTTPProxy;
    }

    var mode = (params.ParseMode || '').toLowerCase();
    if (['markdown', 'html', 'markdownv2'].indexOf(mode) !== -1) {
        Telegram.parse_mode = mode;
    }

    // Modo silencioso por severidade (0=Not classified ... 4=High, 5=Disaster)
    var sev = parseInt(params.Severity, 10),
        silentBelow = parseInt(params.SilentBelow, 10);
    if (!isNaN(sev) && !isNaN(silentBelow) && sev < silentBelow) {
        Telegram.silent = true;
    }

    var subject = (params.Subject || '').trim(),
        body = params.Message || '';
    Telegram.message = subject !== '' ? subject + '\n' + body : body;

    if (Telegram.parse_mode !== null) {
        Telegram.message = Telegram.escapeMarkup(Telegram.message, Telegram.parse_mode);
    }

    Telegram.sendMessage();

    return 'OK';
}
catch (error) {
    Zabbix.log(4, '[Telegram Webhook] notification failed: ' + error);
    throw 'Sending failed: ' + error + '.';
}
