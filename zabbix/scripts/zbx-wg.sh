#!/bin/sh
# Instalação no host com WireGuard (template "NOC - WireGuard"):
#   cp zbx-wg.sh /usr/local/bin/ && chmod 755 /usr/local/bin/zbx-wg.sh
#   /etc/sudoers.d/zabbix-wg:   zabbix ALL=(root) NOPASSWD: /usr/bin/wg show all dump
#   /etc/zabbix/zabbix_agentd.d/wireguard.conf  (zabbix_agent2.d no agent 2):
#     UserParameter=wg.discovery,/usr/local/bin/zbx-wg.sh discovery
#     UserParameter=wg.handshake[*],/usr/local/bin/zbx-wg.sh handshake $1 $2
#     UserParameter=wg.rx[*],/usr/local/bin/zbx-wg.sh rx $1 $2
#     UserParameter=wg.tx[*],/usr/local/bin/zbx-wg.sh tx $1 $2
#   reinicie o agente.
# Zabbix: leitura dos peers do WireGuard. Uso: zbx-wg.sh discovery | handshake IF PEER | rx IF PEER | tx IF PEER
DUMP=$(sudo -n /usr/bin/wg show all dump 2>/dev/null) || { echo "ZBX_NOTSUPPORTED: wg show falhou (sudoers?)"; exit 0; }
NOW=$(date +%s)
case "$1" in
  discovery)
    echo "$DUMP" | awk -F'\t' 'BEGIN{printf "["} NF==9{if(n++)printf ","; printf "{\"{#WGIF}\":\"%s\",\"{#WGPEER}\":\"%s\",\"{#WGALLOWED}\":\"%s\"}",$1,$2,$5} END{print "]"}' ;;
  handshake)
    echo "$DUMP" | awk -F'\t' -v i="$2" -v p="$3" -v now="$NOW" 'NF==9 && $1==i && $2==p {print ($6==0 ? -1 : now-$6)}' ;;
  rx)
    echo "$DUMP" | awk -F'\t' -v i="$2" -v p="$3" 'NF==9 && $1==i && $2==p {print $7}' ;;
  tx)
    echo "$DUMP" | awk -F'\t' -v i="$2" -v p="$3" 'NF==9 && $1==i && $2==p {print $8}' ;;
esac
