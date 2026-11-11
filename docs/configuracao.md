# O arquivo noc.yaml

Tudo o que é da sua empresa fica neste arquivo: nomes, IPs, links, quem liga em quem. As telas e os hosts do
Zabbix saem dele. O [`noc.exemplo.yaml`](../noc.exemplo.yaml) é um exemplo completo e comentado, com dois sites e
uma nuvem. O jeito mais rápido é copiar e trocar os dados.

Antes de começar, três regras do formato YAML:
- **indentação só com espaços**, nunca TAB;
- **`#`** começa um comentário;
- texto com `:` ou `#` vai **entre aspas**.

O `python noc.py validar` aponta onde está o erro.

## Estrutura

```yaml
empresa: Minha Empresa        # aparece no cabeçalho das telas
snmp_macro: "{$SNMP_COMMUNITY}"

nuvem:                         # opcional: servidores em nuvem ou datacenter
  ...
sites:                         # um ou mais
  - id: matriz
    ...
  - id: filial-sul
    ...
```

## empresa e snmp_macro

| Campo | Para quê |
|---|---|
| `empresa` | Nome no canto do cabeçalho e no título das telas. |
| `snmp_macro` | Nome da macro do Zabbix com a community SNMP. **Nunca coloque a community no arquivo.** Crie a macro no Zabbix como *Secret text* (ver [instalacao.md](instalacao.md)). |

## nuvem (opcional)

O lugar onde ficam os servidores, e normalmente o próprio Zabbix. Sem este bloco, as abas "Servidores" e "VPN"
não aparecem e o mapa dos sites não desenha a nuvem.

| Campo | Para quê |
|---|---|
| `nome` | Nome da aba e do bloco no mapa (ex.: `Nuvem`, `Datacenter`). |
| `firewall` | `{ host, ip, nome }` do firewall por onde os sites chegam (os túneis terminam nele). |
| `servidores` | Lista de `{ host, ip, so, desc }`. `so` é só a etiqueta do cartão: `win`, `linux`, `ubuntu` ou `bsd`. |
| `outros_firewalls` | (opcional) Firewalls separados, cada um com `servidores: [...]` atrás dele. |
| `fora_do_firewall` | (opcional) Hosts direto na internet, fora de qualquer firewall. |
| `vpn` | (opcional) Host do pfSense com o coletor de VPN. Liga a tela "Acessos VPN" ([vpn-pfsense.md](vpn-pfsense.md)). |

O `noc.py` **não cria** os hosts dos servidores no Zabbix: servidor já costuma estar lá, com o template de
agente de sempre. Ele só precisa estar num destes grupos:
- `Linux servers`, `Windows Server` ou `Zabbix servers`, para os servidores;
- `Rede/Firewall`, para os firewalls.

## sites

Cada site ganha seis telas e um grupo de hosts no Zabbix por categoria (`Matriz/Switches`, `Matriz/WiFi`...).

| Campo | Para quê |
|---|---|
| `id` | Curto, minúsculo, sem espaço nem acento (ex.: `matriz`, `filial-sul`). Vai no endereço das telas: `noc-matriz-mapa`. |
| `nome` | Como aparece nas telas e nos grupos do Zabbix. Pode ter espaço e acento, mas não `/`. |
| `gateway` | Gateway da rede de gerência. Todo equipamento do site pinga este IP como sentinela: se o gateway também não responde, o problema é o caminho até o site, e o alerta do equipamento fica quieto. |
| `roteador` | `{ host, ip, modelo, mikrotik, lan }`. `ip` = o IP que o Zabbix usa para falar SNMP com ele (normalmente o do túnel). `mikrotik: sim` usa o template do MikroTik e gera o script de sentinelas; `lan` = interface onde ficam as sentinelas (padrão `bridge`). |
| `tunel` | (opcional) `{ ip, interface }`: IP do roteador dentro do túnel até a nuvem e nome da interface do túnel. Sem túnel (o Zabbix está na mesma rede), apague o bloco. |
| `links` | Links de internet (abaixo). |
| `equipamentos` | Switches, APs, NVR, controles de acesso... (abaixo). |
| `cameras` | Câmeras (abaixo). |
| `areas` | (opcional) Partes do site com moldura própria no mapa (abaixo). |
| `telas` | (opcional) Quais telas o site ganha. Sem a linha, todas: `[visao-geral, mapa, links, switches, quedas, equipamentos]`. |

### links

```yaml
links:
  - { nome: ALFA, interface: pppoe-alfa, down: 500, up: 250, sentinela: 172.22.10.250, sonda: 1.0.0.1,
      ip_publico: 198.51.100.24, gateway: 198.51.100.1, rotulo: "fibra · PPPoE" }
```

| Campo | Para quê |
|---|---|
| `nome` | Único **na empresa toda**: vira o item `WAN ALFA: internet`. Letras maiúsculas, números, `-` ou `_`. |
| `interface` | Interface do link no roteador (a do PPPoE, se for PPPoE). |
| `down`, `up` | Banda contratada, em Mbps, só o número. As telas mostram o uso contra ela. |
| `sentinela` | IP livre na rede de gerência. O roteador liga esse IP quando o link tem internet e desliga quando não tem. |
| `sonda` | IP na internet com rota fixa só por este link (cada link usa uma sonda diferente: 1.0.0.1, 9.9.9.9, 1.1.1.1...). |
| `ip_publico` | (opcional) IP fixo do link. Cria o host `LINK-<NOME>`, pingado da nuvem: o link continua visível com o túnel fora. |
| `gateway` | (opcional) Gateway da operadora, para medir latência e perda até ele. |
| `dhcp_faixa` | (opcional) O link recebe IP por DHCP do modem: começo do IP que o modem entrega (ex.: `"192.168.100."`). Alerta quando o roteador fica sem IP dessa faixa. Um por roteador. |
| `rotulo` | (opcional) Texto curto no mapa (ex.: `fibra · PPPoE`). |

**Por que sentinela e sonda?** Pingar o roteador não diz se cada link tem internet. O roteador testa cada
link e mostra o resultado acendendo ou apagando um IP sentinela:
- **teste:** o Netwatch pinga a sonda, que só sai por aquele link;
- **resultado:** o Zabbix pinga a sentinela pelo túnel; se ela responde, o link tem internet.

O `noc.py gerar` escreve os comandos do MikroTik em `saida/mikrotik/<site>.rsc`. Com outro roteador, faça o
equivalente: um IP que acende e apaga conforme um teste por link.

### equipamentos

```yaml
equipamentos:
  - { id: SW01, tipo: switch, host: SW-MTZ-01, ip: 172.22.10.11, nome: Core, liga: "RTR:ether3", porta: 25 }
  - { id: AP01, tipo: ap, host: AP-MTZ-01, ip: 172.22.30.11, nome: AP Recepção, liga: "SW01:23", modelo: grandstream }
  - { id: AC03, tipo: acesso, host: ACESSO-MTZ-PATIO, ip: 172.22.20.43, liga: "AP05:wifi" }
```

| Campo | Para quê |
|---|---|
| `id` | Apelido curto, só usado dentro do arquivo (no `liga` dos outros). Único no site. `RTR` é reservado para o roteador. |
| `tipo` | `switch`, `ap`, `nvr`, `acesso`, `interfone`, `nas` ou `outro`. Define o template, o grupo e o ícone. |
| `host` | Nome **exato** do host no Zabbix. Único na empresa. |
| `ip` | IP do equipamento. |
| `nome` | (opcional) Nome curto no mapa. Sem ele, aparece o `host`. |
| `liga` | Onde ele está ligado: `"ID:PORTA"`. `"RTR:ether3"` = porta ether3 do roteador; `"SW01:24"` = porta 24 do SW01; `"AP05:wifi"` = ligado sem fio pelo AP05. |
| `porta` | (opcional) Porta **deste** equipamento usada na ligação (o uplink). |
| `modelo` | (opcional) Aparece embaixo do nome no mapa. Num `ap`, `grandstream` usa o template SNMP dos Grandstream GWN; outro AP fica só no ping. |
| `porta_servico` | (opcional, `acesso`) Porta TCP que o controle de acesso atende (padrão 80). |

**Porta numérica:** o mapa casa o número com o fim do nome da interface no switch (`GigabitEthernet0/24`,
`ge24`, `1/0/24` → 24). Funciona com a maioria dos switches. Porta com nome (`ether3`, `sfp1`) casa pelo nome
exato.

| Tipo | Template | Grupo do Zabbix | O que monitora |
|---|---|---|---|
| `switch` | NOC - Switch | `<site>/Switches` | ping, SNMP (portas, tráfego, erros, CPU) |
| `ap` + `modelo: grandstream` | NOC - AP Grandstream GWN | `<site>/WiFi` | ping, SNMP (uptime, CPU, memória, rádios, porta) |
| `ap` | NOC - Dispositivo (ping) | `<site>/WiFi` | ping |
| `nvr` | NOC - NVR | `<site>/CFTV/NVR` | ping, SNMP |
| `acesso` | NOC - Controle de acesso | `<site>/Acesso` | ping e porta do serviço |
| `interfone` | NOC - Dispositivo (ping) | `<site>/Acesso` | ping |
| `nas`, `outro` | NOC - Dispositivo (ping) | `<site>/Outros` | ping |

### cameras

```yaml
cameras:
  - { host: CAM-MTZ-01, ip: 172.22.20.31, liga: "SW02:1" }
```

As câmeras não viram caixas no mapa (seriam dezenas). Elas aparecem como um contador embaixo do switch:
"câmeras 4 · 1 fora". Também entram nas dependências: câmera atrás de um switch caído não gera alerta. O
`rotulo` (opcional) é o nome curto na lista de câmeras fora; sem ele, vale o fim do host (`CAM-MTZ-01` → `01`).

### areas

```yaml
areas:
  - { nome: Expedição, raiz: SW04 }
```

Uma área é um equipamento e tudo o que está atrás dele. Ganha moldura no mapa e um filtro próprio. Use para um
galpão ou andar que fica atrás do **mesmo** roteador.

## Galpão: área ou site?

| O galpão... | Use |
|---|---|
| fica no mesmo endereço e sai pela internet do mesmo roteador | uma **área** do site |
| fica em outro endereço, com roteador e link próprios | um **site** novo |

Para um site novo, copie o bloco de um site inteiro (do `- id:` até antes do próximo `- id:`) e troque os dados.
O exemplo tem os dois casos: a "Expedição" é área da Matriz, e o "Galpão Norte" é outro site.

## Depois de mudar o arquivo

```
python noc.py validar        # confere
python noc.py gerar          # gera de novo a pasta saida/
```

- **Grafana:** reimporte as telas que mudaram. Elas sobrescrevem as anteriores pelo endereço (UID).
- **Zabbix:** reimporte o `3-hosts.yaml`, sem marcar "Delete missing". Equipamento removido do arquivo não é apagado do Zabbix: remova à mão.
- **Dependências:** rode `python noc.py dependencias --aplicar` de novo.
