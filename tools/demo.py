#!/usr/bin/env python3
"""Demonstração sem Zabbix e sem Grafana: desenha as telas geradas com dados INVENTADOS a partir do noc.yaml.

Serve para conferir a configuração antes de importar (o mapa saiu como você esperava?) e para gerar as imagens
da documentação. Os painéis Business Text são JavaScript comum, então rodam num Chromium sem Grafana: este script
entrega a eles dados no mesmo formato que o plugin do Zabbix entrega.

    pip install playwright pyyaml && python -m playwright install chromium
    python noc.py gerar
    python tools/demo.py                 # lê noc.yaml e saida/grafana/, grava saida/demo/*.png
    python tools/demo.py -c noc.exemplo.yaml -g saida/grafana -o docs/img

Os valores (CPU, tráfego, quedas, usuários da VPN) são sorteados. Nada vem de rede real.
"""
import json, os, random, re, sys, time

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(AQUI))
import noc  # noqa: E402

random.seed(42)
AGORA = int(time.time())


# ------------------------------------------------------------------------------------------- inventário fictício
class Host:
    def __init__(self, nome, grupos, site=None, tipo=""):
        self.nome, self.grupos, self.site, self.tipo, self.itens = nome, grupos, site, tipo, {}

    def add(self, item, gerador):
        self.itens[item] = gerador


def serie(v, ruido=0.0):
    return lambda n: [max(0, v * (1 + random.uniform(-ruido, ruido))) if isinstance(v, (int, float)) else v for _ in range(n)]


def fora_em(janelas, n):
    """1 = no ar; 0 dentro de cada janela (início, fim) dada em fração da série."""
    return [0 if any(a <= i / n < b for a, b in janelas) else 1 for i in range(n)]


def inventario(cfg, cenario):
    H, P = {}, []
    caidos = set(cenario.get("caidos", []))
    tun_fora = set(cenario.get("tunel_fora", []))

    def h(nome, grupos, site=None, tipo=""):
        H[nome] = Host(nome, grupos, site, tipo)
        return H[nome]

    for s in cfg["sites"]:
        N, sid = s["nome"], s["id"]
        vis = sid not in tun_fora
        r = h(s["roteador"]["host"], ["Rede/Roteadores", f"{N}/Rede"], sid, "roteador")
        r.add("SNMP agent availability", serie(1 if vis else 0))
        if s["tunel"]:
            r.add("Túnel até a RB: disponível", serie(1 if vis else 0))
        r.add("CPU utilization", serie(random.randint(8, 30), .3)); r.add("Memory utilization", serie(random.randint(20, 45), .05))
        r.add("Device: Temperature", serie(random.randint(45, 60))); r.add("Uptime", serie(random.randint(20, 120) * 86400))
        for l in s["links"]:
            r.add(f"WAN {l['nome']}: internet", serie(0 if l["nome"] in cenario.get("links_fora", []) else 1))
            if l["dhcp_faixa"]:
                r.add("WAN {$WAN.DHCP.NOME}: DHCP client com IP", serie(1))
        portas = {l["interface"]: (l, None) for l in s["links"]}
        for e in s["equip"]:
            if e["pai"] == "RTR":
                portas[str(e["porta_pai"])] = (None, e)
        if s["tunel"] and s["tunel"]["interface"]:
            portas[s["tunel"]["interface"]] = (None, None)
        if vis:
            for nome_if, (l, e) in portas.items():
                alias = f"WAN-{l['nome']} {l['down']}/{l['up']}" if l else ""
                pre = f"Interface {nome_if}({alias})"
                cap = (l["down"] or 100) * 1e6 if l else 1e9
                r.add(pre + ": Operational status", serie(1)); r.add(pre + ": Speed", serie(0 if nome_if.startswith("pppoe") else 1e9))
                r.add(pre + ": Bits received", serie(cap * random.uniform(.15, .55), .25)); r.add(pre + ": Bits sent", serie(cap * random.uniform(.05, .2), .25))
                r.add(pre + ": Interface type", serie(23 if nome_if.startswith("pppoe") else 6))
                r.add(pre + ": Inbound packets with errors", serie(0)); r.add(pre + ": Outbound packets with errors", serie(0))
        for l in s["links"]:
            if l["ip_publico"]:
                g = h("LINK-" + l["nome"], ["Rede/Links", f"{N}/Rede"], sid, "link")
                g.add("ICMP: disponível", serie(1)); g.add("ICMP: perda de pacotes", serie(0))
                g.add("ICMP: tempo de resposta", serie(random.uniform(.004, .012), .2)); g.add("ICMP: variação da latência (jitter 5m)", serie(.0008))
        usados = {}
        for e in s["equip"]:
            if e["pai"]:
                usados.setdefault(e["pai"], set()).add(e["porta_pai"])
            if e["porta"]:
                usados.setdefault(e["id"], set()).add(e["porta"])
        for c in s["cams"]:
            usados.setdefault(c["pai"], set()).add(c["porta_pai"])
        pai = {e["id"]: e["pai"] for e in s["equip"]}

        def caiu(eid):
            x = eid
            while x and x != "RTR":
                if (dict((e["id"], e["host"]) for e in s["equip"]).get(x)) in caidos:
                    return True
                x = pai.get(x)
            return False
        for e in s["equip"]:
            x = h(e["host"], [f"{N}/{noc.CATEGORIA[e['tipo']]}"], sid, e["tipo"])
            up = 0 if (not vis or caiu(e["id"])) else 1
            x.add("ICMP: disponível", lambda n, up=up, q=e["host"] in cenario.get("quedas", []):
                  fora_em([(.3, .32), (.71, .73)], n) if q and up else (fora_em([(.95, 1.01)], n) if not up and vis else serie(up)(n)))
            x.add("ICMP: perda de pacotes", serie(0 if up else 100)); x.add("Gateway do site (via túnel): disponível", serie(1 if vis else 0))
            if e["tipo"] in ("switch", "nvr", "ap"):
                x.add("SNMP agent availability", serie(up))
            if e["tipo"] == "acesso":
                x.add("Serviço TCP 80: disponível", serie(up))
            if e["tipo"] == "switch" and up:
                x.add("CPU utilization", serie(random.randint(5, 20))); x.add("Memory utilization", serie(random.randint(30, 50)))
                x.add("Uptime", serie(random.randint(30, 200) * 86400)); x.add("Temperature", serie(random.randint(38, 48)))
                for p in range(1, 29):
                    pre = f"Interface GigabitEthernet0/{p}"
                    ativo = p in usados.get(e["id"], set())
                    x.add(pre + ": Operational status", serie(1 if ativo else 2)); x.add(pre + ": Speed", serie(1e9 if ativo else 0))
                    x.add(pre + ": Bits received", serie(random.uniform(1e6, 60e6) if ativo else 0, .3))
                    x.add(pre + ": Bits sent", serie(random.uniform(2e6, 120e6) if ativo else 0, .3))
                    x.add(pre + ": Inbound packets with errors", serie(0)); x.add(pre + ": Outbound packets with errors", serie(0))
                    x.add(pre + ": Duplex status", serie(3 if ativo else 1))
        for c in s["cams"]:
            x = h(c["host"], [f"{N}/CFTV/Cameras"], sid, "camera")
            up = 0 if (not vis or c["host"] in caidos or caiu(c["pai"])) else 1
            x.add("ICMP: disponível", (lambda n: fora_em([(.95, 1.01)], n)) if (not up and vis) else serie(up)); x.add("ICMP: perda de pacotes", serie(0 if up else 100))
            x.add("Gateway do site (via túnel): disponível", serie(1 if vis else 0))
    nv = cfg["nuvem"]
    if nv:
        fws = ([nv["firewall"]] if nv["firewall"] else []) + nv["outros_firewalls"]
        for f in fws:
            x = h(f["host"], ["Rede/Firewall"], None, "firewall")
            x.add("ICMP: disponível", serie(1)); x.add("SNMP agent availability", serie(1)); x.add("CPU utilization", serie(9, .2))
            x.add("Memory utilization", serie(31)); x.add("System uptime", serie(88 * 86400))
        for sv in nv["servidores"] + nv["fora"]:
            grupo = "Windows Server" if sv["so"] == "win" else ("Zabbix servers" if "zabbix" in sv["host"].lower() else "Linux servers")
            x = h(sv["host"], [grupo], None, "servidor")
            x.add("Zabbix agent availability", serie(1)); x.add("ICMP: disponível", serie(1))
            cpu = 93 if sv["host"] in cenario.get("cpu_alta", []) else random.randint(5, 45)
            x.add("CPU utilization", serie(cpu, .1)); x.add("Memory utilization", serie(random.randint(30, 80), .03))
            x.add("System uptime", serie(random.randint(5, 90) * 86400))
            if sv["so"] == "win":
                x.add("FS [(C:)]: Space: Used, in %", serie(random.randint(35, 70)))
                if "SQL" in sv["host"]:
                    x.add("FS [(D:)]: Space: Used, in %", serie(91))
            else:
                x.add("/: Space utilization", serie(random.randint(25, 60)))
        if nv["vpn"] and nv["vpn"] in H:
            H[nv["vpn"]].add("OpenVPN: dados (JSON)", lambda n, nv=nv: [json.dumps(vpn_json(cfg))])
    for hn, sev, txt, idade in cenario.get("problemas", []):
        if hn in H:
            P.append({"name": txt, "severity": str(sev), "lastchange": str(AGORA - idade), "acknowledged": "0", "hosts": [{"name": hn}],
                      "_grupos": H[hn].grupos})
    return H, P


def vpn_json(cfg):
    D = 86400
    nomes = ("ana.souza bruno.lima carla.dias diego.alves elisa.rocha fabio.nunes gabriela.melo heitor.reis isabela.cruz joao.pires "
             "karina.lopes lucas.matos marina.freitas nicolas.ramos olivia.castro paulo.vieira renata.gomes samuel.teixeira").split()
    serv = [("1", "RA-USUARIOS", "server_tls_user", "acesso", "1194", "UDP4", ["Local Database"])]
    for i, s in enumerate(cfg["sites"]):
        if s["tunel"]:
            serv.append((str(i + 2), "S2S-" + s["id"].upper(), "p2p_tls", "site", str(1195 + i), "UDP4", []))
    us = []
    for i, n in enumerate(nomes):
        on = i < 4
        ult = AGORA if on else AGORA - int(random.choice([.3, 1, 2, 4, 9, 15, 30, 50, 62]) * D)
        us.append({"u": n, "origem": "local", "on": 1 if on else 0, "desde": AGORA - random.randint(600, 9000) if on else None,
                   "ip": [f"203.0.113.{40 + i}"] if on else [], "vip": [f"10.8.0.{10 + i}"] if on else [], "rx": random.randint(10 ** 6, 9 * 10 ** 8) if on else None,
                   "tx": random.randint(10 ** 6, 3 * 10 ** 8) if on else None, "srv": ["RA-USUARIOS"], "ultima": ult, "primeira": AGORA - 70 * D,
                   "desabilitado": False, "expira": None, "cert_vence": AGORA + random.choice([400, 700, 20]) * D,
                   "ip_ultimo": f"198.51.100.{20 + i}", "ips_recentes": [{"ip": f"198.51.100.{20 + i}", "ts": ult}]})
    servs = [{"id": a, "nome": b, "modo": c, "tipo": t, "porta": p, "proto": pr, "auth": au, "desabilitado": False,
              "pares": ([b.lower()] if t == "site" else []), "no_ar": True, "conectados": 4 if t == "acesso" else 0,
              "falhas_1h": 0, "falhas_24h": 2 if t == "acesso" else 0, "ruido_24h": 120 if t == "acesso" else 9} for a, b, c, t, p, pr, au in serv]
    certs = [{"ref": "c1", "tipo": "ca", "nome": "CA-USUARIOS", "cn": "CA", "vence": AGORA + 2700 * D, "servidores": ["RA-USUARIOS"], "revogado": False}]
    certs += [{"ref": "u" + u["u"], "tipo": "usuario", "nome": u["u"], "cn": u["u"], "usuario": u["u"], "vence": u["cert_vence"],
               "servidores": ["RA-USUARIOS"], "revogado": False} for u in us]
    seg = {"cobre_desde": AGORA - 2 * D, "logs": 3,
           "vpn": {"falhas_1h": 0, "falhas_24h": 2, "recusados_1h": 6, "recusados_24h": 88, "ruido_24h": 129, "ok_24h": 23,
                   "dessinc_1h": 0, "dessinc_24h": 3, "dessinc_pico": 2, "dessinc_pico_ts": AGORA - 5 * 3600,
                   "por_srv": [{"id": "1", "nome": "RA-USUARIOS", "falhas_1h": 0, "falhas_24h": 2, "ruido_24h": 120}],
                   "ip": [{"ip": "198.51.100.200", "n": 41, "srv": "RA-USUARIOS"}, {"ip": "192.0.2.77", "n": 18, "srv": "RA-USUARIOS"}],
                   "ip_ruido": [], "u": [{"u": "admin", "n": 37}, {"u": "test", "n": 21}, {"u": "carla.dias", "n": 6}, {"u": "vpn", "n": 5}]},
           "gui": {"falhas_1h": 0, "falhas_24h": 0, "ok_24h": 2, "ip": [], "u": []},
           "ssh": {"falhas_1h": 0, "falhas_24h": 0, "ok_24h": 1, "bloqueios_24h": 0, "ip": [], "u": []},
           "config": {"ultima_ts": AGORA - 3 * 3600, "ultima": "admin@198.51.100.9: Firewall: Rules - saved/edited a firewall rule.",
                      "mudancas_24h": 2, "lista": [{"ts": AGORA - 3 * 3600, "por": "admin", "ip": "198.51.100.9", "desc": "Firewall: Rules - saved/edited a firewall rule."},
                                                   {"ts": AGORA - 20 * 3600, "por": "(system)", "ip": "", "desc": "Cron: updated job zbx_ovpn.php"}]}}
    return {"ts": AGORA - 60, "historico_desde": AGORA - 70 * D, "servidores": servs, "usuarios": us, "certificados": certs, "seguranca": seg,
            "resumo": {"servidores": len(servs), "servidores_no_ar": len(servs), "conectados": 4, "usuarios": len(us), "certificados": len(certs),
                       "tuneis": len(servs) - 1, "tuneis_conectados": 1}}


# ------------------------------------------------------------------------------------------- consultas
def casa(filtro, valor, variaveis):
    if filtro in (None, ""):
        return True
    for k, v in variaveis.items():
        filtro = filtro.replace("$" + k, v)
    if filtro.startswith("/") and filtro.rfind("/") > 0:
        return re.search(filtro[1:filtro.rfind("/")], valor) is not None
    return filtro == valor


def frames(alvo, H, P, n, variaveis):
    g = (alvo.get("group") or {}).get("filter", "/.*/")
    hf = (alvo.get("host") or {}).get("filter", "/.*/")
    it = (alvo.get("item") or {}).get("filter", "/.*/")
    ref = alvo["refId"]
    hosts = [x for x in H.values() if any(casa(g, gr, variaveis) for gr in x.grupos) and casa(hf, x.nome, variaveis)]
    if str(alvo.get("queryType")) == "5":
        nomes = {x.nome for x in hosts}
        lst = [{k: v for k, v in p.items() if not k.startswith("_")} for p in P if p["hosts"][0]["name"] in nomes]
        return [{"refId": ref, "fields": [{"name": "Problems", "type": "other", "values": lst}]}]
    out = []
    for x in hosts:
        for nome, ger in x.itens.items():
            if not casa(it, nome, variaveis):
                continue
            v = ger(n)
            tipo = "string" if v and isinstance(v[0], str) else "number"
            out.append({"refId": ref, "name": f"{x.nome}: {nome}",
                        "fields": [{"name": "time", "type": "time", "values": [0] * len(v)},
                                   {"name": "value", "type": tipo, "labels": {"host": x.nome, "item": nome},
                                    "config": {"displayNameFromDS": f"{x.nome}: {nome}"}, "values": v}]})
    return out


# ------------------------------------------------------------------------------------------- renderização
PAGINA = """<html><head><meta charset="utf-8"><style>body{background:#0b0f17;margin:0;font-family:Inter,Segoe UI,Arial,sans-serif;color:#e6edf7}
.pn{position:absolute;overflow:hidden}</style>%s</head><body><div id="g" style="position:relative;width:%dpx;height:%dpx"></div></body></html>"""
# cada painel num shadow DOM: o CSS de um painel não vaza para o outro (como no Grafana)
RODAR = """([id, code, css, S, passo]) => { const now = Date.now();
  S.forEach(f => f.fields.forEach(x => { if (x.type === 'time') x.values = x.values.map((_, i, a) => now - (a.length - 1 - i) * passo); }));
  const host = document.getElementById(id), sh = host.attachShadow({ mode: 'open' });
  sh.innerHTML = '<style>:host{display:block}' + css + '</style><div class="el" style="height:100%;font-family:Inter,Segoe UI,Arial,sans-serif;color:#e6edf7"><div class="noc" style="height:100%"></div></div>';
  (new Function('context', code))({ element: sh.querySelector('.el'), panel: { panelData: { series: S } } }); }"""


def render(painel_json, H, P, saida, largura=1920, variaveis=None, passo=60000, n=60, acoes=None):
    from playwright.sync_api import sync_playwright
    d = json.load(open(painel_json, encoding="utf-8"))
    variaveis = variaveis or {"host": ".*", "switch": ".*"}   # variáveis do dashboard em "All"
    texto = [p for p in d["panels"] if p.get("type") == "marcusolsson-dynamictext-panel"]
    col, lin = largura / 24, 38
    alt = max(p["gridPos"]["y"] + p["gridPos"]["h"] for p in texto) * lin
    css = ""
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page(viewport={"width": largura, "height": int(alt) + 10})
        erros = []
        pg.on("pageerror", lambda e: erros.append(str(e)))
        pg.set_content(PAGINA % (css, largura, alt))
        for p in texto:
            gp = p["gridPos"]
            st = f"left:{gp['x'] * col + 4}px;top:{gp['y'] * lin + 4}px;width:{gp['w'] * col - 8}px;height:{gp['h'] * lin - 8}px"
            pg.evaluate("([id, st]) => { const e = document.createElement('div'); e.id = id; e.className = 'pn'; e.style.cssText = st; document.getElementById('g').appendChild(e); }",
                        [f"p{p['id']}", st])
        for p in texto:
            S = []
            for a in p.get("targets", []):
                S += frames(a, H, P, n, variaveis)
            pg.evaluate(RODAR, [f"p{p['id']}", p["options"]["afterRender"], p["options"]["styles"], S, passo])
        pg.wait_for_timeout(400)
        for a in acoes or []:
            a(pg); pg.wait_for_timeout(250)
        pg.screenshot(path=saida, full_page=True)
        b.close()
    print(f"  {os.path.basename(saida):34} {'ok' if not erros else 'ERROS: ' + '; '.join(erros)}")
    return not erros


def main(argv):
    conf, gdir, odir = "noc.yaml", os.path.join("saida", "grafana"), os.path.join("saida", "demo")
    a = list(argv)
    for flag in ("-c", "-g", "-o"):
        if flag in a:
            i = a.index(flag); v = a[i + 1]; del a[i:i + 2]
            if flag == "-c": conf = v
            elif flag == "-g": gdir = v
            else: odir = v
    cfg = noc.carregar(conf)
    os.makedirs(odir, exist_ok=True)
    s0 = cfg["sites"][0]
    aps = [e["host"] for e in s0["equip"] if e["tipo"] == "ap"]
    sws = [e["host"] for e in s0["equip"] if e["tipo"] == "switch"]
    sql = next((x["host"] for x in (cfg["nuvem"] or {}).get("servidores", []) if "SQL" in x["host"]), None)
    cen = {"caidos": aps[-1:] + [s0["cams"][-1]["host"]] if s0["cams"] else aps[-1:], "quedas": sws[1:2] + aps[:1],
           "problemas": ([(aps[-1], 3, f"{aps[-1]}: sem resposta ao ping", 900)] if aps else []) +
                        ([(s0["cams"][-1]["host"], 2, "Sem resposta ao ping", 600)] if s0["cams"] else []) +
                        ([(sql, 3, f"{sql}: FS [(D:)]: uso de disco acima de 90%", 5400)] if sql else [])}
    H, P = inventario(cfg, cen)
    ok = True
    print("Telas (dados inventados):")
    for f in sorted(os.listdir(gdir)):
        if not f.endswith(".json") or f.endswith("-detalhe.json"):
            continue
        nome = f[:-5]
        passo, n = (15 * 60000, 7 * 96) if nome.endswith("-quedas") else (60000, 60)
        ok &= render(os.path.join(gdir, f), H, P, os.path.join(odir, nome + ".png"), passo=passo, n=n)
    # cenário extra: túnel do primeiro site fora
    cen2 = dict(cen, tunel_fora=[s0["id"]], problemas=cen["problemas"] + [(s0["roteador"]["host"], 4, f"Túnel até {s0['nome']} fora", 300)])
    H2, P2 = inventario(cfg, cen2)
    m = os.path.join(gdir, f"noc-{s0['id']}-mapa.json")
    if os.path.exists(m):
        ok &= render(m, H2, P2, os.path.join(odir, f"noc-{s0['id']}-mapa-tunel-fora.png"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
