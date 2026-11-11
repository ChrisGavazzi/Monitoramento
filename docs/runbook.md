# Runbook de alertas

Para cada alerta dos templates deste repositório: o que significa e o que fazer. "Site" é cada local do
`noc.yaml` (matriz, filial, galpão); "roteador" é o roteador de borda dele.

## Antes de agir

- **Durante evento, só se apaga incêndio.** Corrigir o que caiu pode; melhorar o que funciona fica para depois.
- **Roteador MikroTik: sempre em Safe Mode.** Nunca remova regra por número, procure pelo comentário. Depois de
  mexer em firewall, teste se o túnel reconecta.
- **pfSense: desative antes de apagar.** Para desfazer: *Diagnostics → Backup & Restore → Config History*.
- **Nunca cole senha, community SNMP, PSK ou token em chat ou chamado.**
- **Toda ação que mudou alguma coisa vai para um registro de mudanças:** data, o quê, por quê e como desfazer.

## Triagem: um site perdeu acesso à nuvem

```
Alerta "Túnel até <site> fora"
  └─ algum link do site com internet?  (tela Links e VPN)
       ├─ não → operadora: modem/ONT, cabo, chamado
       └─ sim → servidor OpenVPN do túnel no ar no firewall da nuvem?  (tela VPN, "Servidores e túneis")
                 ├─ não → firewall: Status → Services, iniciar o OpenVPN
                 └─ sim → roteador do site, em Safe Mode: /interface ovpn-client print, ver o erro
```

## Segurança do firewall (template NOC - pfSense OpenVPN)

| Alerta | Sev. | Significa | Fazer |
|---|---|---|---|
| Falhas de login no SSH | High | O SSH só abre de dentro da VPN, então alguém já na VPN está tentando entrar no firewall. | Pegue o IP (da VPN) na tela, veja de quem é em "Conectados agora", derrube a sessão (*Status → OpenVPN*), desative o usuário. |
| Muitas falhas de login na VPN | Warning | Mais de `{$OVPN.FALHAS.1H}` recusas na última hora. Quase sempre robô contra servidor só com senha. | No card "Tentativas", veja servidor, IPs e usuários tentados. Usuário em vermelho é conta que existe: peça a troca da senha. IP que se repete por horas pode ser bloqueado na WAN. |
| Falhas de login no webGUI | Warning | Se o webGUI só aceita IPs confiáveis, ou alguém da equipe errou a senha ou a regra de restrição deixou de valer. | Veja o IP de origem. Se não for da equipe, confira a regra e troque a senha do admin. |
| Configuração do pfSense alterada | Info | Alguém salvou uma mudança (quem, IP, o quê). Fecha sozinho. | Reconhecida, nada a fazer. Ninguém reconhece: incidente. Veja o diff no Config History e troque as senhas. |
| /etc/passwd has been changed (template FreeBSD padrão) | Warning | Usuário local criado, alterado ou removido. | Procure uma "Configuração alterada" em User Manager no mesmo horário. Sem ela: `grep -v nologin /etc/passwd`. |

## VPN

| Alerta | Sev. | Significa | Fazer |
|---|---|---|---|
| Servidor OpenVPN X parado | High | Ninguém conecta naquele servidor. Se for o do túnel de um site, o site perde a nuvem. | *Status → Services*, iniciar. Se não subir, *Status → System Logs → OpenVPN*. |
| Certificado vence em até 7 / 30 dias | High / Warning | Quando vencer, ninguém conecta, ou o túnel cai. | Renove em *System → Cert. Manager*. Se a CA mudar, reexporte os clientes; num túnel, troque também do outro lado. |
| Coletor da VPN parado | Warning | O JSON não atualiza há mais de 10 min; a tela fica com dado velho. Comum depois de atualizar o pfSense. | *Services → Cron*: linha do `zbx_ovpn.php`. Rode `--resumo` à mão para ver o erro. |
| Certificados de usuário vencendo | Info | Algum certificado de usuário vence em 15 dias. | Filtro "Certificado ≤ 30 d" na tela; renove e mande a nova configuração. |

## Site: links e túnel

| Alerta | Sev. | Significa | Fazer |
|---|---|---|---|
| Túnel até <site> fora | High | O site está sem os sistemas da nuvem, e o Zabbix sem visão do site. | Triagem acima. |
| Túnel VPN fora com link no ar | High | A internet funciona, o túnel não sobe. O problema é o túnel ou o firewall, não a operadora. | Servidor do túnel no firewall e cliente no roteador. |
| <LINK> sem internet | High | O link daquela operadora caiu. Sem link reserva, o site fica isolado. | Chamado na operadora; confira interface e DHCP/PPPoE no roteador. |
| Gateway da operadora sem resposta | High | O roteador não alcança o primeiro salto da operadora. | Físico ou operadora: modem/ONT, cabo, chamado. |
| Link sem resposta (IP público) | High | O IP público não responde de fora. | Se o gateway responde, o problema está depois dele: chamado. |
| Link sem IP no DHCP client | High | O roteador não recebeu IP da operadora. | Reinicie modem/ONT; não voltou, chamado. |
| Perda / latência / jitter alto | Warning | Link degradado, mas no ar. | Acompanhe; passou de 30 min, chamado com o gráfico. |

## Site: equipamentos

Vários equipamentos fora ao mesmo tempo: olhe primeiro o switch de onde eles saem (tela Mapa).

| Alerta | Sev. | Significa | Fazer |
|---|---|---|---|
| Sem resposta ao ping (switch, NVR) | High | Caiu, ou caiu o caminho. Tudo abaixo de um switch cai junto. | Energia e uplink. No NVR, confira também se continua gravando. |
| Sem resposta ao ping (AP, controle de acesso) | Average | Desligado, sem cabo ou sem PoE. | Porta do switch (link, PoE) na tela Switches; reinicie o PoE da porta. |
| Sem resposta ao ping (câmera) | Warning | Mesmo caso. | Muitas juntas apontam para switch ou energia. |
| Porta do serviço não responde | Average | Pinga, mas o serviço parou. | Reinicie o serviço ou o equipamento. |
| Perda de pacotes alta | Warning | Cabo, conector ou porta. | Erros na porta (tela Switches); troque o cabo. |
| SNMP sem resposta (AP) | Warning | Pinga, mas o SNMP não responde: community trocada ou SNMP desligado. | Compare a community do controlador com a macro de community do `noc.yaml` (`snmp_macro`). |
| Rádio desligado (AP) | Average | Um rádio (2,4 ou 5 GHz) desligado. | Religue no controlador; veja se foi de propósito. |
| Porta abaixo de N Mbps (AP) | Warning | A porta negociou abaixo do esperado (100 em vez de 1000). | Quase sempre cabo ou conector. |
| AP reiniciou | Info | O uptime do equipamento zerou. Uma vez é normal. | Repetindo: fonte ou PoE. |
| CPU / Memória alta (AP) | Warning | AP sobrecarregado, em geral por excesso de clientes. | Acompanhe; persistindo, reinicie fora do horário. |

## Nuvem

| Alerta | Sev. | Significa | Fazer |
|---|---|---|---|
| Site indisponível | High | O site não responde por HTTPS. | Abra de fora; veja o servidor web e o NAT da 443. |
| Certificado: sem coleta há 8 h | Warning | O Zabbix parou de checar o certificado e não vai avisar o vencimento. | Item do certificado ativo e sem erro. |
| Túnel WireGuard sem handshake | High | Um peer não conversa há tempo demais (o alerta diz qual, pelos IPs permitidos). | Lado do peer ligado e com internet; `wg show` mostra o último handshake. |

## Evento

Olhe o agregado antes do equipamento: dez câmeras fora ao mesmo tempo quase nunca são dez problemas de câmera.

| Alerta | Sev. | Fazer |
|---|---|---|
| Categoria: X% ou mais fora do ar | High | Causa comum: mesmo switch, energia ou link. Comece pelo switch. |
| Categoria: N ou mais fora do ar | Average | Mesmo setor ou mesmo switch? Espalhados: um a um. |
| Roteador de borda sem ping | Disaster | Evento sem internet. Links e energia do rack primeiro. |
| Mylaps Decoder sem ping | Disaster | Cronometragem parada. Acione a equipe de cronometragem; porta do switch. |
| Hypervisor sem ping | Disaster | Todas as VMs daquele host caem. Energia e rede do servidor. |
| Firewall, switches, servidores, NVR, facial, link WAN sem ping | High | Equipamento crítico. Facial e NVR têm também "Serviço TCP não responde": pinga, serviço parou. |
| Câmera, dispositivo ICMP sem ping | Average | Porta e PoE. |
| AP, modem 4G das equipes | Warning | Energia e porta. "Sinal 4G fraco": mudar o modem de lugar ou de operadora. |
