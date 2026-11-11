# Kit para eventos

Uma rede montada por alguns dias, com centenas de equipamentos monitorados por ping: câmeras, controle de acesso,
equipes, cronometragem, Wi-Fi e links. A lógica é a mesma das telas dos sites, mas as telas do evento são
organizadas por **categoria**, não por topologia. Num evento a pergunta é "quantas câmeras estão fora?", e não
"atrás de qual switch".

Este kit ainda não passa pelo `noc.py`. Os dashboards e os templates de `evento/` são importados direto e
encontram os hosts pelos **grupos** do Zabbix.

## Templates (`evento/templates/`)

Importe os três arquivos em *Data collection → Templates → Import*:
- `templates-evento.yaml`: um template por tipo de equipamento;
- `template-evento-switch-ruckus.yaml`;
- `template-evento-agregados.yaml`: os alertas por categoria.

| Template | Para | Alerta de "sem ping" |
|---|---|---|
| NOC Evento - Roteador de Borda | roteador de borda | Disaster |
| NOC Evento - Mylaps Decoder | decoders de cronometragem | Disaster |
| NOC Evento - Hypervisor VMware | hosts de VM | Disaster |
| NOC Evento - Firewall, Switch Cisco/Huawei/Intelbras/Ruckus, Servidor Linux/Windows, Race Control, NVR-DVR Intelbras, Facial Intelbras, Mylaps Infra, Link WAN | infraestrutura | High |
| NOC Evento - Camera IP, Dispositivo ICMP | câmeras e equipamentos simples | Average |
| NOC Evento - AP Ruckus, Teltonika Equipe | APs e modems 4G das equipes | Warning |
| NOC Evento - Agregados | um host "agregado", com alertas como "Câmeras: 20% ou mais fora do ar" | High / Average |

Os agregados são o mais importante num evento. Dez câmeras fora ao mesmo tempo quase nunca são dez problemas de
câmera: é o switch, a energia ou o link. O alerta agregado aponta isso de uma vez. Os percentuais e quantidades
ficam em macros do host agregado (`{$AGG.CAM.PCT}`, `{$AGG.CAM.MIN}`...).

## Grupos de hosts

As telas buscam os hosts por estes grupos. Crie-os e coloque cada equipamento no seu:

```
Evento/Rede/Roteador        Evento/Rede/Firewall       Evento/Rede/Switches     Evento/Rede/Links
Evento/WiFi                 Evento/Servidores          Evento/Race Control      Evento/Equipes
Evento/CFTV/Cameras         Evento/CFTV/LPR            Evento/CFTV/NVR-DVR
Evento/Acesso/Faciais       Evento/Acesso/Carreta
Evento/Cronometragem/Decoders                          Evento/Cronometragem/Infra
```

Se o seu evento não tem cronometragem ou LPR, não crie o grupo: a seção correspondente fica vazia.

## Telas (`evento/dashboards/`)

| Arquivo | Tela |
|---|---|
| `visao-geral.json` | resumo de todas as categorias, com o que está fora |
| `rede.json`, `sw-ap.json`, `switches-borda.json` | roteador, firewall, switches, Wi-Fi |
| `links.json` | links de internet do evento |
| `servidores.json` | servidores e rede |
| `cftv.json`, `acesso.json`, `seguranca.json` | câmeras, LPR, gravadores, faciais e acesso |
| `cronometragem.json`, `equipes.json` | decoders e infraestrutura de cronometragem; modems 4G das equipes |

Importe em *Dashboards → New → Import*, escolhendo o datasource do Zabbix **do evento**. Se o evento tem um
Zabbix próprio, crie um datasource só para ele.

## Dica de operação

Monte e teste tudo um ou dois dias antes, com os equipamentos ligando. Na véspera, congele: só se corrige o que
caiu. Melhoria fica para depois do evento.
