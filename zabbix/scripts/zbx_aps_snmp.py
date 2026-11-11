#!/usr/bin/env python3
"""APs de um grupo (padrão: variável ZBX_GRUPO, ex.: "Matriz/WiFi"): troca a interface "agente Zabbix" (porta 10050, que o AP não usa) por uma interface SNMP v2c.

Por que existe: o template "NOC - AP Grandstream GWN" tem itens SNMP, e o Zabbix só aceita item SNMP em host com
interface SNMP. Então a ordem é: 1) este script, 2) importar zabbix/templates/noc-templates.yaml.

O que faz em cada AP (por host, nesta ordem; se algo falhar ele para e mostra onde):
  1. cria a interface SNMP (mesmo IP, porta 161, v2c, community = macro global {$SNMP_COMMUNITY} (ou a variável ZBX_MACRO));
  2. passa os itens de ping, que estavam na interface de agente, para a interface SNMP;
  3. apaga a interface de agente.
AP que já tem interface SNMP é pulado. Pode rodar quantas vezes quiser.

Antes: crie em Administration → Macros a macro global {$SNMP_COMMUNITY} (ou a variável ZBX_MACRO), tipo Secret text, com a community do GDMS.

Uso (no VPS do Zabbix):
  read -s ZBX_TOKEN ; export ZBX_TOKEN
  python3 zbx_aps_snmp.py              # simulação (só mostra)
  python3 zbx_aps_snmp.py --host "AP-MTZ-01" --aplicar   # grava só em um AP (faça este primeiro)
  python3 zbx_aps_snmp.py --aplicar    # grava em todos
URL da API: variável ZBX_URL (padrão http://127.0.0.1/zabbix/api_jsonrpc.php).
"""
import json, os, sys, urllib.request

GRUPO = os.environ.get("ZBX_GRUPO", "Matriz/WiFi")
MACRO = os.environ.get("ZBX_MACRO", "{$SNMP_COMMUNITY}")
URL = os.environ.get("ZBX_URL", "http://127.0.0.1/zabbix/api_jsonrpc.php")
TOKEN = os.environ.get("ZBX_TOKEN", "")
APLICAR = "--aplicar" in sys.argv
SO = sys.argv[sys.argv.index("--host") + 1] if "--host" in sys.argv else None
_id = 0

def api(method, params):
    global _id; _id += 1
    body = json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": _id}).encode()
    hdr = {"Content-Type": "application/json-rpc"}
    if method != "apiinfo.version": hdr["Authorization"] = "Bearer " + TOKEN
    r = json.load(urllib.request.urlopen(urllib.request.Request(URL, body, hdr), timeout=30))
    if "error" in r: raise SystemExit(f"ERRO {method}: {r['error'].get('message')} {r['error'].get('data')}")
    return r["result"]

def main():
    if not TOKEN: raise SystemExit("Defina ZBX_TOKEN (read -s ZBX_TOKEN; export ZBX_TOKEN).")
    print("Zabbix API", api("apiinfo.version", {}), "em", URL, "| modo:", "APLICAR" if APLICAR else "SIMULAÇÃO")
    if not api("usermacro.get", {"globalmacro": True, "output": ["macro"], "filter": {"macro": MACRO}}):
        raise SystemExit(f"Falta o macro global {MACRO} (Administration → Macros, tipo Secret text). Nada foi alterado.")
    g = api("hostgroup.get", {"output": ["groupid"], "filter": {"name": [GRUPO]}})
    if not g: raise SystemExit(f"Grupo {GRUPO} não encontrado.")
    hosts = api("host.get", {"output": ["hostid", "host", "name"], "groupids": g[0]["groupid"], "selectInterfaces": "extend"})
    if SO:
        hosts = [h for h in hosts if h["name"] == SO or h["host"] == SO]
        if not hosts: raise SystemExit(f"Host {SO} não está em {GRUPO}.")
    print(f"{len(hosts)} host(s) em {GRUPO}\n")
    feitos = pulados = 0
    for h in sorted(hosts, key=lambda x: x["name"]):
        ifs = h["interfaces"]
        snmp = [i for i in ifs if i["type"] == "2"]
        agente = [i for i in ifs if i["type"] == "1"]
        if snmp:
            com = (snmp[0].get("details") or {}).get("community", "")
            if com and not com.startswith("{$"):
                print(f"  {h['name']:10} AVISO: community escrita direto na interface SNMP (qualquer um que abre o host vê). Troque por {MACRO}.")
        if snmp and not agente:
            print(f"  {h['name']:10} ok: só interface SNMP ({snmp[0]['ip']}:{snmp[0]['port']})")
            pulados += 1; continue
        if not agente:
            print(f"  {h['name']:10} sem interface de agente nem SNMP — confira à mão"); continue
        ag = agente[0]
        itens = [i for i in api("item.get", {"output": ["itemid", "name", "interfaceid"], "hostids": h["hostid"]}) if i["interfaceid"] == ag["interfaceid"]]
        acao = f"usar SNMP existente {snmp[0]['ip']}:{snmp[0]['port']}" if snmp else f"criar SNMP {ag['ip']}:161"
        print(f"  {h['name']:10} {ag['ip']}: {acao} · mover {len(itens)} item(ns) · apagar agente :{ag['port']}")
        if not APLICAR: continue
        if snmp: novo = snmp[0]["interfaceid"]
        else: novo = api("hostinterface.create", {"hostid": h["hostid"], "type": 2, "main": 1, "useip": 1, "ip": ag["ip"], "dns": "", "port": "161",
                                                  "details": {"version": 2, "bulk": 1, "community": MACRO}})["interfaceids"][0]
        for i in itens:
            api("item.update", {"itemid": i["itemid"], "interfaceid": novo})
        api("hostinterface.delete", [ag["interfaceid"]])
        feitos += 1
    print(f"\n{'Alterados' if APLICAR else 'A alterar'}: {feitos if APLICAR else len(hosts) - pulados} · já certos: {pulados}")
    if not APLICAR: print("Simulação: nada foi gravado. Rode de novo com --aplicar.")
    else: print("Próximo passo: importar zabbix/templates/noc-templates.yaml (Create new + Update existing, sem Delete missing).")

if __name__ == "__main__":
    main()
