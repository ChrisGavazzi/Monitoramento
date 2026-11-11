# Instalação

Ordem: **gerar → Zabbix → roteadores → Grafana → dependências**. Para a primeira vez, reserve uma tarde. A parte
que mais toma tempo é levantar quem liga em quem para o `noc.yaml`.

## 0. Gerar

No seu computador (Windows, Linux ou Mac), com Python 3.8 ou mais novo:

```
pip install pyyaml
cp noc.exemplo.yaml noc.yaml          # Windows: copy noc.exemplo.yaml noc.yaml
# edite o noc.yaml (docs/configuracao.md)
python noc.py validar
python noc.py gerar
```

Sai a pasta `saida/`:

```
saida/LEIAME.txt                           a ordem de importação, com os nomes dos seus arquivos
saida/zabbix/1-templates-noc.yaml          templates genéricos
saida/zabbix/2-templates-internet-sites.yaml  um template de internet por site
saida/zabbix/3-hosts.yaml                  os hosts dos sites
saida/grafana/noc-<site>-<tela>.json       as telas
saida/mikrotik/<site>.rsc                  sentinelas e Netwatch de cada roteador MikroTik
```

## 1. Zabbix

### Importar

**Data collection → Templates → Import**, um arquivo por vez, nesta ordem:
1. `1-templates-noc.yaml`
2. `2-templates-internet-sites.yaml`
3. `3-hosts.yaml`, em **Data collection → Hosts → Import**.

Nas opções da importação:
- deixe **desmarcado** "Delete missing" em tudo. Com ele marcado, uma reimportação apaga o que você acrescentou à mão;
- marque **"Update existing"** quando estiver reimportando depois de mudar o `noc.yaml`.

O roteador MikroTik usa o template **Mikrotik by SNMP**, que já vem com o Zabbix. Outro roteador usa o
**Network Generic Device by SNMP**, também padrão.

### Macro da community SNMP

**Administration → Macros**: crie a macro do `snmp_macro` (padrão `{$SNMP_COMMUNITY}`) com a community real,
tipo **Secret text**. Todos os hosts SNMP usam essa macro. Assim a community não fica escrita em arquivo nenhum.
Se cada site tem uma community diferente, crie a mesma macro em cada host e ela vale no lugar da global.

### Servidores

O `noc.py` não cria os servidores; eles já devem estar no Zabbix com o template de agente de sempre
(*Linux by Zabbix agent*, *Windows by Zabbix agent*). Confira se:
- cada servidor está em `Linux servers`, `Windows Server` ou `Zabbix servers`;
- o firewall da nuvem está em `Rede/Firewall`;
- o `host` no `noc.yaml` é o nome exato do host no Zabbix.

## 2. Roteadores

O alerta de internet por link precisa que o roteador acenda um IP sentinela quando o link tem internet
([configuracao.md](configuracao.md#links)).

**MikroTik:** abra `saida/mikrotik/<site>.rsc` e revise antes de colar.
- **Links que não são PPPoE:** a linha da rota tem `GATEWAY_DA_OPERADORA` para você trocar pelo gateway daquele link.
- **Como colar:** no terminal do roteador, ligue o **Safe Mode** (Ctrl+X) e cole uma linha por vez.
- **Como conferir:** `/ip address print where comment~"NOC"` lista as sentinelas. A do link com internet deve ficar habilitada em até 20 segundos.

**Outro roteador:** faça o equivalente com o que ele tiver. É preciso um teste por link (ping a um IP que só
sai por aquele link) que liga e desliga um endereço IP.

**SNMP:** libere o acesso do IP do Zabbix (ou do túnel), com a mesma community da macro.

## 3. Grafana

### Plugins e datasource

No servidor do Grafana:

```
grafana-cli plugins install alexanderzobnin-zabbix-app
grafana-cli plugins install marcusolsson-dynamictext-panel
systemctl restart grafana-server
```

1. **Administration → Plugins → Zabbix → Enable.** O plugin do Zabbix é um *app* e precisa ser habilitado.
2. **Connections → Data sources → Add → Zabbix.**
   - URL: `http://<seu-zabbix>/api_jsonrpc.php` (ou `/zabbix/api_jsonrpc.php`).
   - Autenticação: token de API (*Users → API tokens*) de um usuário com leitura nos grupos dos sites e dos servidores.
   - *Save & test*.

### Telas

**Dashboards → New → Import → Upload JSON file**, cada arquivo de `saida/grafana/`, escolhendo o datasource do
Zabbix quando pedir.
- Importe **todas** as telas: as abas do cabeçalho apontam umas para as outras pelo endereço (UID), e uma tela que faltar vira aba quebrada.
- Reimportar o mesmo arquivo sobrescreve a tela. Não cria cópia.

Não é preciso mudar o `grafana.ini`: o JavaScript das telas roda no painel Business Text sem configuração extra.

## 4. Dependências de alerta

Sem isso, um switch fora gera um alerta para ele e outro para cada câmera e AP atrás dele. O comando lê a
topologia do `noc.yaml` e grava as dependências pela API:
- cada equipamento passa a depender do "Sem resposta ao ping" do equipamento acima dele;
- tudo do site passa a depender do "Túnel até <site> fora".

Linux:
```
read -s ZBX_TOKEN; export ZBX_TOKEN
export ZBX_URL=http://<seu-zabbix>/zabbix/api_jsonrpc.php
python noc.py dependencias              # só mostra
python noc.py dependencias --aplicar    # grava
```

Windows (PowerShell):
```
$env:ZBX_TOKEN = Read-Host "Token do Zabbix"     # fica só nesta janela do PowerShell
$env:ZBX_URL = "http://<seu-zabbix>/zabbix/api_jsonrpc.php"
python noc.py dependencias --aplicar
```

O token precisa de permissão de escrita nos hosts dos sites. Pode rodar quantas vezes quiser: ele só muda o que
falta.

## 5. Alertas no Telegram (opcional)

`zabbix/media/telegram-webhook.js` é um tipo de mídia *webhook*: crie em **Alerts → Media types**, com o token do
bot e o chat como parâmetros. O que cada alerta significa e o que fazer está em [runbook.md](runbook.md).

## Extras

- **WireGuard:** template *NOC - WireGuard* e o script `zabbix/scripts/zbx-wg.sh` para o agente. A instalação está nos comentários do começo do script.
- **Acessos VPN do pfSense:** [vpn-pfsense.md](vpn-pfsense.md).
- **APs que já estão no Zabbix com interface de agente:** `zabbix/scripts/zbx_aps_snmp.py` troca para SNMP pela API. Só mostra até você usar `--aplicar`.
