# Acessos OpenVPN e segurança do pfSense

O pfSense não expõe por SNMP quem está conectado na VPN nem há quanto tempo cada usuário não conecta. Aqui isso
vem de um coletor em PHP que roda no próprio pfSense, grava um JSON, e o agente Zabbix lê esse arquivo.

```
pfSense: cron (2 min) → zbx_ovpn.php → /usr/local/zbx_ovpn/ovpn.json
Zabbix:  agente no pfSense lê o JSON (vfs.file.contents) → itens dependentes e descoberta no template
Grafana: tela "NOC — Acessos VPN" lê o mesmo item e desenha usuários, servidores, certificados e tentativas
```

**O que o coletor lê.** Só leitura: não altera configuração e não derruba ninguém.

- Servidores OpenVPN da configuração e quem está conectado agora (socket de gerência de cada servidor).
- Certificados: a CA e o certificado de cada servidor, e os certificados de usuário assinados por essas CAs,
  com data de vencimento.
- A última vez que cada usuário foi visto conectado, guardada em `estado.json`.
- Logs das últimas 24 h:
  - falhas de login na VPN, por servidor;
  - falhas de login no webGUI e no SSH;
  - bloqueios do sshguard.
- O histórico de mudanças de configuração, o mesmo de *Diagnostics → Backup & Restore → Config History*.
- O **último IP público** de cada usuário (os 5 mais recentes, com horário). Vem da conexão ativa ou, para quem
  já saiu, da linha `connected` do log. Fica em `estado.json` e sobrevive à rotação do log.
- **Chaves fora de sincronia** (`TLS keys are out of sync`, `AEAD Decrypt error`) por hora, com o pico do dia.
  Um pico logo depois de reiniciar uma instância é normal; contínuo, aponta cliente com sessão velha.

Se o pfSense manda syslog para outro servidor, o coletor também grava no log o mapa **PID → servidor OpenVPN**
(`ovpn-map: pid=... server=ovpnsN name="..."`), quando o mapa muda ou uma vez por dia. As linhas do OpenVPN só
trazem o PID, que muda a cada reinício: sem esse registro, um log guardado por anos não diz de qual servidor
cada linha veio.

Testado no pfSense 2.7 e 2.8.

## Instalação

1. **Pasta.** Em *Diagnostics → Command Prompt → Execute Shell Command*:
   `mkdir -p /usr/local/zbx_ovpn`
   Use `/usr/local`, não `/tmp` nem `/var`: estes podem ser RAM disk e somem no reboot, levando o histórico de
   "dias sem conexão".
2. **Arquivo.** Na mesma tela, *Upload File* com `pfsense/zbx_ovpn.php` (ele vai para `/tmp`), e depois:
   `cp /tmp/zbx_ovpn.php /usr/local/zbx_ovpn/`
3. **Teste.** `php -q /usr/local/zbx_ovpn/zbx_ovpn.php --resumo`
   Mostra contagens e nomes de campos, sem listar usuários e sem gravar nada.
   `php -q /usr/local/zbx_ovpn/zbx_ovpn.php --diag` mostra o que foi reconhecido nos logs (IPs e usuários
   mascarados). Se alguma linha importante cair em "OUTRAS", o formato do seu log é diferente do esperado.
4. **Agendamento.** Instale o pacote **Cron** (*System → Package Manager*) e crie em *Services → Cron*:
   minuto `*/2`, demais campos `*`, usuário `root`, comando
   `/usr/local/bin/php -q /usr/local/zbx_ovpn/zbx_ovpn.php`
5. **Agente Zabbix.** Pacote **zabbix-agent** no pfSense, com o servidor Zabbix liberado. O item do template é
   `vfs.file.contents[/usr/local/zbx_ovpn/ovpn.json]`, que o agente lê como arquivo comum.
6. **Template.** O *NOC - pfSense OpenVPN* já vem no `1-templates-noc.yaml`. Vincule-o **só** ao host do pfSense
   que tem o OpenVPN.
7. **Tela.** No `noc.yaml`, coloque o host do pfSense em `nuvem.vpn` e rode `python noc.py gerar`. A tela
   `noc-nuvem-vpn.json` sai pronta, com as consultas apontando para esse host.

## Alertas do template

| Alerta | Severidade | Quando |
|---|---|---|
| Coletor da VPN parado | Warning | o JSON não é atualizado há mais de `{$OVPN.ATRASO}` (10 min) |
| Servidor OpenVPN X parado | High | servidor ligado na configuração, sem processo |
| Certificado (CA, servidor ou túnel) vence em até `{$OVPN.CERT.CRIT}` / `{$OVPN.CERT.AVISO}` dias | High / Warning | 7 / 30 dias |
| Certificados de usuário vencendo | Info | algum certificado de usuário vence em 15 dias |
| Muitas falhas de login na VPN | Warning | `{$OVPN.FALHAS.1H}` (20) recusas na última hora |
| Falhas de login no webGUI | Warning | `{$GUI.FALHAS.1H}` (3) na última hora |
| Falhas de login no SSH | High | `{$SSH.FALHAS.1H}` (3) na última hora. Pensado para SSH acessível só pela VPN: falha ali é alguém de dentro. |
| Configuração do pfSense alterada | Info | a cada mudança salva, com quem, de qual IP e o quê. Fecha sozinho. |

## Limitações

- **Histórico.** Usuários do AD/LDAP não existem no pfSense: só aparecem depois da primeira conexão com o
  coletor rodando. "Dias sem conexão" só fica confiável depois de 45 dias de coletor; até lá a tela avisa.
- **Usuário recusado sem servidor.** A linha "user X could not authenticate" vem do script de autenticação do
  pfSense, sem IP e sem servidor. Por isso a contagem por servidor e os IPs de origem vêm de outras linhas do log,
  e podem não fechar exatamente com a contagem de usuários recusados.
- **Último IP só para quem já está no histórico.** Tentativas e conexões sem usuário (`UNDEF`) não criam
  usuário. O nome é o que o OpenVPN registra, que pode ser o CN do certificado e não a conta; com *Strict
  User-CN Matching* ligado no servidor, os dois coincidem.
- **Dados pessoais.** O JSON e o `estado.json` têm nomes de usuários e IPs. O item guarda 1 dia de histórico de propósito. Restrinja
  quem vê a tela.

## Auditoria pontual

`pfsense/vpn_auditoria.php` é só leitura e lista o que costuma virar porta aberta:

- servidores LDAP sem criptografia ou sem filtro de grupo;
- OpenVPN só com senha, sem CRL ou sem chave TLS;
- CAs sem uso e certificados soltos;
- usuários locais com nome genérico.

Rode com `php -q /tmp/vpn_auditoria.php` depois do upload. A saída não traz senhas nem chaves, mas traz nomes de
usuários e IPs internos.
