#!/usr/bin/env python3
"""NOC em Zabbix + Grafana: gera tudo a partir de um arquivo de configuração (noc.yaml).

    python noc.py validar                  confere o noc.yaml e mostra o que vai ser gerado
    python noc.py gerar                    cria saida/ (telas do Grafana, hosts e templates do Zabbix, scripts MikroTik)
    python noc.py dependencias             mostra as dependências de alerta que faltam no Zabbix (não grava nada)
    python noc.py dependencias --aplicar   grava as dependências pela API do Zabbix

Opções: -c ARQUIVO (padrão: noc.yaml)   -o PASTA (padrão: saida)
A API do Zabbix (só no "dependencias") vem das variáveis ZBX_URL e ZBX_TOKEN.
Precisa de Python 3.8+ e PyYAML (pip install pyyaml).
"""
import copy, hashlib, ipaddress, json, os, re, shutil, sys, urllib.request

RAIZ = os.path.dirname(os.path.abspath(__file__))
MODELOS = os.path.join(RAIZ, "modelos")
CODIGO = os.path.join(MODELOS, "codigo")

TIPOS = ("switch", "ap", "nvr", "acesso", "interfone", "nas", "outro")
TELAS_SITE = [("visao-geral", "Visão geral"), ("mapa", "Mapa"), ("links", "Links e VPN"), ("switches", "Switches"),
              ("quedas", "Quedas e energia"), ("equipamentos", "Equipamentos")]
TELAS_NUVEM = [("servidores", "Servidores"), ("detalhe", "Detalhe"), ("vpn", "VPN")]
GRUPOS_SERVIDORES = "Linux servers|Windows Server|Zabbix servers"
# grupo do Zabbix, template e tipo do mapa de cada tipo de equipamento
CATEGORIA = {"switch": "Switches", "ap": "WiFi", "nvr": "CFTV/NVR", "camera": "CFTV/Cameras", "acesso": "Acesso",
             "interfone": "Acesso", "nas": "Outros", "outro": "Outros"}
TEMPLATE = {"switch": "NOC - Switch", "nvr": "NOC - NVR", "camera": "NOC - Câmera", "acesso": "NOC - Controle de acesso",
            "interfone": "NOC - Dispositivo (ping)", "nas": "NOC - Dispositivo (ping)", "outro": "NOC - Dispositivo (ping)"}
SNMP_TIPOS = ("switch", "nvr")
TIPO_MAPA = {"interfone": "tvip"}


class Erro(Exception):
    pass


# ----------------------------------------------------------------------------------------------------- utilitários
def u4(semente):
    """UUID v4 determinístico (o Zabbix exige v4; gerar sempre igual evita duplicar na reimportação)."""
    h = hashlib.md5(semente.encode("utf-8")).hexdigest()
    return h[:12] + "4" + h[13:16] + "89ab"[int(h[16], 16) % 4] + h[17:32]


def sim(v):
    return v is True or str(v).strip().lower() in ("sim", "s", "yes", "y", "true", "1")


def rx_esc(s):
    """Texto literal dentro de uma regex do plugin Zabbix do Grafana (/.../)."""
    return re.sub(r"([\\.^$|?*+()\[\]{}/])", r"\\\1", s)


def rx_hosts(hosts):
    return "/^(" + "|".join(rx_esc(h) for h in hosts) + ")$/" if hosts else "/^$/"


def rx_grupos(grupos):
    return "/" + "|".join("^" + rx_esc(g) + "$" for g in grupos) + "/" if grupos else "/^$/"


def ler_json(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def gravar(p, texto):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(texto)


def yaml_mod():
    try:
        import yaml
        return yaml
    except ImportError:
        raise Erro("falta o PyYAML. Instale com:  pip install pyyaml")


# ----------------------------------------------------------------------------------------------------- configuração
def carregar(caminho):
    if not os.path.exists(caminho):
        raise Erro(f"não achei {caminho}. Copie noc.exemplo.yaml para noc.yaml e edite.")
    with open(caminho, encoding="utf-8") as f:
        txt = f.read()
    if caminho.endswith(".json"):
        cfg = json.loads(txt)
    else:
        yaml = yaml_mod()
        try:
            cfg = yaml.safe_load(txt)
        except yaml.YAMLError as e:
            raise Erro(f"{caminho} não é um YAML válido: {e}\nDica: confira a indentação (só espaços) e as aspas.")
    return validar(cfg or {})


class Checagem:
    def __init__(self):
        self.erros, self.avisos = [], []

    def erro(self, onde, msg):
        self.erros.append(f"{onde}: {msg}")

    def aviso(self, onde, msg):
        self.avisos.append(f"{onde}: {msg}")


def _ip(ck, onde, v, obrig=True):
    if v in (None, ""):
        if obrig:
            ck.erro(onde, "falta o IP")
        return None
    try:
        return str(ipaddress.ip_address(str(v).strip()))
    except ValueError:
        ck.erro(onde, f"IP inválido: {v!r}")
        return None


def _texto(ck, onde, v, obrig=True):
    if v in (None, ""):
        if obrig:
            ck.erro(onde, "campo obrigatório vazio")
        return ""
    return str(v).strip()


def validar(cfg):
    ck = Checagem()
    out = {"empresa": _texto(ck, "empresa", cfg.get("empresa")) or "NOC",
           "snmp_macro": str(cfg.get("snmp_macro") or "{$SNMP_COMMUNITY}").strip()}
    if not re.fullmatch(r"\{\$[A-Z0-9_.]+\}", out["snmp_macro"]):
        ck.erro("snmp_macro", 'use o nome de uma macro do Zabbix, ex.: "{$SNMP_COMMUNITY}" (nunca a community em si)')
    todos_hosts = {}

    def host_unico(onde, h):
        if h in todos_hosts:
            ck.erro(onde, f'host "{h}" repetido (já usado em {todos_hosts[h]})')
        else:
            todos_hosts[h] = onde

    # --- nuvem
    nv = cfg.get("nuvem")
    out["nuvem"] = None
    if nv:
        o = "nuvem"
        fw = nv.get("firewall") or {}
        n = {"nome": _texto(ck, o + ".nome", nv.get("nome")) or "Nuvem", "servidores": [], "outros_firewalls": [], "fora": [],
             "firewall": None, "vpn": None}
        if fw:
            n["firewall"] = {"host": _texto(ck, o + ".firewall.host", fw.get("host")), "ip": _ip(ck, o + ".firewall.ip", fw.get("ip"), False),
                             "nome": str(fw.get("nome") or "firewall").strip()}
            host_unico(o + ".firewall", n["firewall"]["host"])
        for i, s in enumerate(nv.get("servidores") or []):
            oo = f"{o}.servidores[{i + 1}]"
            sv = {"host": _texto(ck, oo + ".host", s.get("host")), "ip": _ip(ck, oo + ".ip", s.get("ip"), False),
                  "so": str(s.get("so") or "").strip().lower(), "desc": str(s.get("desc") or "").strip()}
            host_unico(oo, sv["host"]); n["servidores"].append(sv)
        for i, f in enumerate(nv.get("outros_firewalls") or []):
            oo = f"{o}.outros_firewalls[{i + 1}]"
            of = {"host": _texto(ck, oo + ".host", f.get("host")), "ip": _ip(ck, oo + ".ip", f.get("ip"), False),
                  "nome": str(f.get("nome") or f.get("host") or "").strip(), "servidores": [str(x) for x in (f.get("servidores") or [])]}
            host_unico(oo, of["host"]); n["outros_firewalls"].append(of)
        for i, s in enumerate(nv.get("fora_do_firewall") or []):
            oo = f"{o}.fora_do_firewall[{i + 1}]"
            sv = {"host": _texto(ck, oo + ".host", s.get("host")), "ip": _ip(ck, oo + ".ip", s.get("ip"), False),
                  "so": str(s.get("so") or "").strip().lower(), "desc": str(s.get("desc") or "").strip()}
            host_unico(oo, sv["host"]); n["fora"].append(sv)
        nomes_srv = {s["host"] for s in n["servidores"]}
        for f in n["outros_firewalls"]:
            for h in f["servidores"]:
                if h not in nomes_srv:
                    ck.erro(f"nuvem.outros_firewalls ({f['host']})", f'servidor "{h}" não está na lista nuvem.servidores')
        if nv.get("vpn"):
            n["vpn"] = str(nv["vpn"]).strip()
        out["nuvem"] = n

    # --- sites
    sites = cfg.get("sites") or []
    if not sites:
        ck.erro("sites", "nenhum site. Configure pelo menos um (veja noc.exemplo.yaml).")
    out["sites"] = []
    ids, nomes, links_globais = set(), set(), {}
    for i, s in enumerate(sites):
        o = f"sites[{i + 1}]"
        st = {"id": str(s.get("id") or "").strip(), "nome": _texto(ck, o + ".nome", s.get("nome"))}
        o = f"site {st['nome'] or i + 1}"
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,19}", st["id"]):
            ck.erro(o + ".id", f'"{st["id"]}": use até 20 letras minúsculas, números ou "-", sem espaço nem acento')
        if st["id"] in ids:
            ck.erro(o + ".id", f'id "{st["id"]}" repetido')
        if st["nome"] in nomes:
            ck.erro(o + ".nome", f'nome "{st["nome"]}" repetido')
        if "/" in st["nome"]:
            ck.erro(o + ".nome", 'não use "/" no nome (ele vira grupo do Zabbix)')
        ids.add(st["id"]); nomes.add(st["nome"])
        st["gateway"] = _ip(ck, o + ".gateway", s.get("gateway"))
        r = s.get("roteador") or {}
        st["roteador"] = {"host": _texto(ck, o + ".roteador.host", r.get("host")), "ip": _ip(ck, o + ".roteador.ip", r.get("ip")),
                          "modelo": str(r.get("modelo") or "").strip(), "mikrotik": sim(r.get("mikrotik")),
                          "lan": str(r.get("lan") or "bridge").strip()}
        host_unico(o + ".roteador", st["roteador"]["host"])
        t = s.get("tunel")
        st["tunel"] = {"ip": _ip(ck, o + ".tunel.ip", t.get("ip")), "interface": str(t.get("interface") or "").strip()} if t else None
        st["links"] = []
        dhcp = 0
        for j, l in enumerate(s.get("links") or []):
            oo = f"{o}.links[{j + 1}]"
            nome = str(l.get("nome") or "").strip().upper()
            if not re.fullmatch(r"[A-Z0-9][A-Z0-9_-]{0,19}", nome):
                ck.erro(oo + ".nome", f'"{l.get("nome")}": use letras, números, "-" ou "_" (vira "WAN {nome}: internet")')
            if nome in links_globais:
                ck.erro(oo + ".nome", f'link "{nome}" já existe em {links_globais[nome]}: o nome do link é único na empresa')
            links_globais[nome] = o
            lk = {"nome": nome, "interface": _texto(ck, oo + ".interface", l.get("interface")),
                  "down": l.get("down"), "up": l.get("up"), "sentinela": _ip(ck, oo + ".sentinela", l.get("sentinela")),
                  "sonda": _ip(ck, oo + ".sonda", l.get("sonda")), "ip_publico": _ip(ck, oo + ".ip_publico", l.get("ip_publico"), False),
                  "gateway": _ip(ck, oo + ".gateway", l.get("gateway"), False), "rotulo": str(l.get("rotulo") or "").strip(),
                  "dhcp_faixa": str(l.get("dhcp_faixa") or "").strip()}
            for k in ("down", "up"):
                if lk[k] is not None and not isinstance(lk[k], (int, float)):
                    ck.erro(f"{oo}.{k}", f"use só o número em Mbps (ex.: 300), não {lk[k]!r}")
            if lk["dhcp_faixa"]:
                dhcp += 1
            if lk["ip_publico"]:
                host_unico(oo + " (host LINK-" + nome + ")", "LINK-" + nome)
            st["links"].append(lk)
        if not st["links"]:
            ck.aviso(o, "nenhum link de internet configurado")
        if dhcp > 1:
            ck.erro(o + ".links", "só um link por roteador pode ter dhcp_faixa (o template MikroTik WAN DHCP olha uma faixa só)")
        # equipamentos
        st["equip"], ids_eq = [], {"RTR"}
        for j, e in enumerate(s.get("equipamentos") or []):
            oo = f"{o}.equipamentos[{j + 1}]"
            eq = {"id": str(e.get("id") or "").strip(), "tipo": str(e.get("tipo") or "").strip().lower(),
                  "host": _texto(ck, oo + ".host", e.get("host")), "ip": _ip(ck, oo + ".ip", e.get("ip")),
                  "nome": str(e.get("nome") or e.get("host") or "").strip(), "liga": str(e.get("liga") or "").strip(),
                  "porta": e.get("porta"), "modelo": str(e.get("modelo") or "").strip(), "porta_servico": e.get("porta_servico")}
            if not re.fullmatch(r"[A-Za-z0-9_]{1,20}", eq["id"]) or eq["id"].upper() == "RTR":
                ck.erro(oo + ".id", f'"{eq["id"]}": use letras, números ou "_" (e não "RTR", que é o roteador)')
            if eq["id"] in ids_eq:
                ck.erro(oo + ".id", f'id "{eq["id"]}" repetido neste site')
            if eq["id"].upper() in links_globais:
                ck.erro(oo + ".id", f'id "{eq["id"]}" tem o nome de um link; use outro')
            if eq["tipo"] not in TIPOS:
                ck.erro(oo + ".tipo", f'"{eq["tipo"]}" não existe. Use: {", ".join(TIPOS)}')
            ids_eq.add(eq["id"]); host_unico(oo, eq["host"]); st["equip"].append(eq)
        st["cams"] = []
        for j, c in enumerate(s.get("cameras") or []):
            oo = f"{o}.cameras[{j + 1}]"
            cam = {"host": _texto(ck, oo + ".host", c.get("host")), "ip": _ip(ck, oo + ".ip", c.get("ip")),
                   "liga": str(c.get("liga") or "").strip(), "rotulo": str(c.get("rotulo") or "").strip()}
            host_unico(oo, cam["host"]); st["cams"].append(cam)
        # ligações
        def liga(oo, v, obrig=True):
            if not v:
                if obrig:
                    ck.erro(oo + ".liga", 'falta onde está ligado ("ID:PORTA", ex.: "SW01:24" ou "RTR:ether3")')
                return None, None
            if ":" not in v:
                ck.erro(oo + ".liga", f'"{v}": use "ID:PORTA", ex.: "SW01:24"')
                return None, None
            pai, porta = v.split(":", 1)
            pai, porta = pai.strip(), porta.strip()
            if pai not in ids_eq:
                ck.erro(oo + ".liga", f'"{pai}" não é o id de nenhum equipamento deste site (nem "RTR")')
                return None, None
            if not porta:
                ck.erro(oo + ".liga", f'"{v}": falta a porta depois do ":"')
            return pai, (int(porta) if porta.isdigit() else porta)
        for j, eq in enumerate(st["equip"]):
            eq["pai"], eq["porta_pai"] = liga(f"{o}.equipamentos[{j + 1}] ({eq['id']})", eq["liga"])
            if isinstance(eq["porta"], str) and eq["porta"].isdigit():
                eq["porta"] = int(eq["porta"])
        for j, c in enumerate(st["cams"]):
            c["pai"], c["porta_pai"] = liga(f"{o}.cameras[{j + 1}] ({c['host']})", c["liga"])
            if not c["rotulo"]:
                c["rotulo"] = re.split(r"[-_ ]", c["host"])[-1]
        # ciclo de ligações
        pai_de = {e["id"]: e["pai"] for e in st["equip"]}
        for e in st["equip"]:
            visto, x = set(), e["id"]
            while x and x != "RTR":
                if x in visto:
                    ck.erro(f"{o}.equipamentos ({e['id']})", "as ligações formam um círculo (A liga em B que liga em A)")
                    break
                visto.add(x); x = pai_de.get(x)
        st["areas"] = []
        for j, a in enumerate(s.get("areas") or []):
            oo = f"{o}.areas[{j + 1}]"
            raiz = str(a.get("raiz") or "").strip()
            if raiz not in pai_de:
                ck.erro(oo + ".raiz", f'"{raiz}" não é o id de um equipamento deste site')
            st["areas"].append({"nome": _texto(ck, oo + ".nome", a.get("nome")), "raiz": raiz})
        telas = s.get("telas")
        validas = [t for t, _ in TELAS_SITE]
        st["telas"] = [str(t).strip() for t in telas] if telas else validas
        for t in st["telas"]:
            if t not in validas:
                ck.erro(o + ".telas", f'tela "{t}" não existe. Use: {", ".join(validas)}')
        out["sites"].append(st)
    if out["nuvem"] and out["nuvem"]["vpn"] and out["nuvem"]["vpn"] not in todos_hosts:
        ck.aviso("nuvem.vpn", f'"{out["nuvem"]["vpn"]}" não está em nenhuma lista do arquivo; confira se é o nome exato do host do pfSense')
    out["_avisos"] = ck.avisos
    if ck.erros:
        raise Erro("o noc.yaml tem problemas:\n  - " + "\n  - ".join(ck.erros))
    return out


# ----------------------------------------------------------------------------------------------------- modelo do NOC (o que as telas recebem)
def uid(cfg, grupo, tela):
    return f"noc-{grupo}-{tela}"


def telas_de(cfg):
    out = []
    for s in cfg["sites"]:
        for t, nome in TELAS_SITE:
            if t in s["telas"]:
                out.append({"grp": s["id"], "uid": uid(cfg, s["id"], t), "nome": nome, "tela": t})
    if cfg["nuvem"]:
        for t, nome in TELAS_NUVEM:
            if t == "vpn" and not cfg["nuvem"]["vpn"]:
                continue
            out.append({"grp": "nuvem", "uid": uid(cfg, "nuvem", t), "nome": nome, "tela": t})
    return out


def hosts_do_site(s):
    hs = [s["roteador"]["host"]] + ["LINK-" + l["nome"] for l in s["links"] if l["ip_publico"]]
    return hs + [e["host"] for e in s["equip"]] + [c["host"] for c in s["cams"]]


def tipo_host(s):
    t = {s["roteador"]["host"]: "roteador"}
    for e in s["equip"]:
        t[e["host"]] = e["tipo"]
    for c in s["cams"]:
        t[c["host"]] = "camera"
    return t


def topo(s):
    nos = [{"id": "RTR", "tipo": "router", "host": s["roteador"]["host"], "nome": s["roteador"]["host"],
            "sub": " · ".join(x for x in (s["roteador"]["modelo"], "borda") if x), "so": "ros" if s["roteador"]["mikrotik"] else ""}]
    links = []
    for l in s["links"]:
        banda = f"{l['down']}/{l['up']}" if l["down"] and l["up"] else ""
        no = {"id": l["nome"], "tipo": "wan", "nome": l["nome"], "sub": " · ".join(x for x in (l["rotulo"], banda) if x), "wan": {"inet": l["nome"]}}
        if l["ip_publico"]:
            no["wan"]["ping"] = "LINK-" + l["nome"]
        nos.append(no)
        links.append({"de": "RTR", "pde": l["interface"], "para": l["nome"]})
    tipo_id = {"RTR": "router"}
    for e in s["equip"]:
        tipo_id[e["id"]] = e["tipo"]
        sub = " · ".join(x for x in (e["ip"], e["modelo"] if e["modelo"].lower() != "grandstream" else "") if x)
        nos.append({"id": e["id"], "tipo": TIPO_MAPA.get(e["tipo"], e["tipo"]), "host": e["host"], "nome": e["nome"], "sub": sub})
    for e in s["equip"]:
        if not e["pai"]:
            continue
        lk = {"de": e["pai"], "pde": e["porta_pai"], "para": e["id"]}
        if e["porta"] not in (None, ""):
            lk["ppara"] = e["porta"]
        if e["porta_pai"] == "wifi":
            lk["pde"] = "wifi"
        elif tipo_id.get(e["pai"]) in ("router", "switch") and e["tipo"] == "switch":
            lk["trunk"] = True
        links.append(lk)
    cams = [{"sw": c["pai"], "p": c["porta_pai"], "host": c["host"], "rotulo": c["rotulo"]} for c in s["cams"] if c["pai"]]
    areas = [{"id": "a" + str(i + 1), "nome": a["nome"].upper(), "curto": a["nome"], "raiz": a["raiz"]} for i, a in enumerate(s["areas"])]
    return {"raiz": "RTR", "nos": nos, "links": links, "areas": areas, "cams": cams}


def mapa_nuvem(cfg, s):
    n = cfg["nuvem"]
    base = {"fw": "", "nome": "", "sub": "", "tunIf": (s["tunel"] or {}).get("interface", ""), "via": [l["nome"] for l in s["links"]],
            "fora": [], "wan": [], "firewalls": [], "info": {}}
    if not n:
        return base
    base.update({"fw": n["firewall"]["host"] if n["firewall"] else "", "nome": n["firewall"]["nome"] if n["firewall"] else "",
                 "sub": n["nome"], "wan": [x["host"] for x in n["fora"]],
                 "firewalls": [{"fw": f["host"], "nome": f["nome"], "hosts": f["servidores"]} for f in n["outros_firewalls"]]})
    info = base["info"]
    if n["firewall"]:
        info[n["firewall"]["host"]] = {"so": "bsd", "ip": n["firewall"]["ip"] or ""}
    for f in n["outros_firewalls"]:
        info[f["host"]] = {"so": "bsd", "ip": f["ip"] or ""}
    for x in n["servidores"] + n["fora"]:
        info[x["host"]] = {k: v for k, v in (("so", x["so"]), ("ip", x["ip"] or ""), ("desc", x["desc"])) if v}
    return base


def noc_base(cfg, grupo, tela):
    telas = telas_de(cfg)
    inicio = {}
    for t in telas:
        inicio.setdefault(t["grp"], t["uid"])
    hosts = {}
    for s in cfg["sites"]:
        for h in hosts_do_site(s):
            hosts[h] = s["id"]
    return {"empresa": cfg["empresa"], "grupo": grupo, "tela": uid(cfg, grupo, tela),
            "telas": [{k: t[k] for k in ("grp", "uid", "nome")} for t in telas],
            "sites": [{"id": s["id"], "nome": s["nome"], "rtr": s["roteador"]["host"], "links": [l["nome"] for l in s["links"]],
                       "tunel": bool(s["tunel"]), "inicio": inicio.get(s["id"], "")} for s in cfg["sites"]],
            "nuvem": {"nome": cfg["nuvem"]["nome"], "inicio": inicio.get("nuvem", "")} if cfg["nuvem"] else None,
            "hosts": hosts}


def secoes(s):
    """Seções da visão geral / equipamentos: uma por grupo de hosts que o site tem."""
    tem = {CATEGORIA[e["tipo"]] for e in s["equip"]} | ({"CFTV/Cameras"} if s["cams"] else set())
    lista = [("Acesso", "Controle de acesso", "ping + porta do serviço", 80), ("CFTV/NVR", "Gravador (NVR)", "ping + SNMP", None),
             ("WiFi", "Wi-Fi (APs)", "", None), ("CFTV/Cameras", "Câmeras", "alerta só com o caminho até o site no ar", None),
             ("Switches", "Switches", "detalhe das portas na tela Switches", None), ("Outros", "Outros equipamentos", "ping", None)]
    out = []
    for cat, titulo, nota, porta in lista:
        if cat in tem:
            out.append({"ref": f"S{len(out) + 1}", "titulo": titulo, "nota": nota, "reserva": None, "porta": porta,
                        "grupo": f"{s['nome']}/{cat}"})
    return out


# ----------------------------------------------------------------------------------------------------- dashboards
def alvo(t, **f):
    t = copy.deepcopy(t)
    for k, v in f.items():
        t[k] = {"filter": v}
    return t


def montar_dashboard(cfg, modelo, grupo, tela, titulo, extras, ajustar):
    d = ler_json(os.path.join(MODELOS, modelo + ".json"))
    d["uid"] = uid(cfg, grupo, tela)
    d["title"] = titulo
    d["tags"] = ["noc", grupo]
    d.pop("id", None)
    noc = noc_base(cfg, grupo, tela)
    noc.update(extras)
    prefixo = "const NOC = " + json.dumps(noc, ensure_ascii=False, separators=(",", ":")) + ";\n"
    for p in d["panels"]:
        if p.get("type") != "marcusolsson-dynamictext-panel":
            continue
        if p["id"] == 900:
            js, css = "comum/cabecalho.js", "comum/cabecalho.css"
        else:
            js, css = f"{modelo}/painel-{p['id']}.js", f"{modelo}/painel-{p['id']}.css"
        with open(os.path.join(CODIGO, js), encoding="utf-8") as f:
            p["options"]["afterRender"] = prefixo + f.read()
        with open(os.path.join(CODIGO, css), encoding="utf-8") as f:
            p["options"]["styles"] = f.read()
    for p in d["panels"]:
        if p["id"] == 900:   # cabeçalho: roteadores e links de todos os sites
            hs = [s["roteador"]["host"] for s in cfg["sites"]] + ["LINK-" + l["nome"] for s in cfg["sites"] for l in s["links"] if l["ip_publico"]]
            p["targets"] = [alvo(t, host=rx_hosts(hs)) if t["refId"] == "A" else t for t in p["targets"]]
    ajustar(d)
    d["__inputs"] = [{"name": "DS_ZABBIX", "label": "Zabbix", "description": "Datasource do Zabbix", "type": "datasource",
                      "pluginId": "alexanderzobnin-zabbix-datasource", "pluginName": "Zabbix"}]
    d["__requires"] = [{"type": "datasource", "id": "alexanderzobnin-zabbix-datasource", "name": "Zabbix", "version": "4.0.0"},
                       {"type": "panel", "id": "marcusolsson-dynamictext-panel", "name": "Business Text", "version": "5.0.0"}]
    return d


def painel(d, pid):
    return next(p for p in d["panels"] if p["id"] == pid)


def dashboards(cfg):
    out = {}
    nv = cfg["nuvem"]
    for s in cfg["sites"]:
        sid, nome, rtr = s["id"], s["nome"], s["roteador"]["host"]
        links_hosts = ["LINK-" + l["nome"] for l in s["links"] if l["ip_publico"]]
        site_hosts = hosts_do_site(s)
        switches = [e["host"] for e in s["equip"] if e["tipo"] == "switch"]
        sec = secoes(s)
        links = [{"roteador": rtr, "iface": l["interface"], "nome": l["nome"], "down": l["down"], "up": l["up"],
                  "gw": "LINK-" + l["nome"] if l["ip_publico"] else ""} for l in s["links"]]
        comum = {"site_nome": nome, "rtr": rtr, "links": links, "links_uid": uid(cfg, sid, "links"),
                 "tipos": tipo_host(s), "rotulos": {c["host"]: c["rotulo"] for c in s["cams"]}}
        cfg_frota = lambda titulo, compacto: {"titulo": titulo, "resumo": False, "compacto": compacto,
                                              "secoes": [{k: x[k] for k in ("ref", "titulo", "nota", "reserva", "porta")} for x in sec]}

        def links_alvos(p):
            novos = []
            for t in p["targets"]:
                r = t["refId"]
                if r in ("R", "S"):
                    novos.append(alvo(t, group="/^Rede\\/Roteadores$/", host=rx_hosts([rtr])))
                elif r == "L":
                    novos.append(alvo(t, group="/^Rede\\/Links$/", host=rx_hosts(links_hosts)))
                elif r == "F":
                    novos.append(alvo(t, group="/^Rede\\/(Roteadores|Links)$/", host=rx_hosts([rtr] + links_hosts)))
                else:
                    novos.append(t)
            p["targets"] = novos

        def frota_alvos(p, com_rede):
            base = next(t for t in p["targets"] if t["refId"] == "S1")
            fbase = next(t for t in p["targets"] if t["refId"] == "F")
            alvos = [alvo(dict(base, refId=x["ref"]), group=rx_grupos([x["grupo"]])) for x in sec]
            grupos = [x["grupo"] for x in sec]
            f = alvo(fbase, group=rx_grupos(grupos + ([f"{nome}/Rede"] if com_rede else [])))
            p["targets"] = alvos + [f]

        for tela, rotulo in TELAS_SITE:
            if tela not in s["telas"]:
                continue
            titulo = f"{cfg['empresa']} {nome} — {rotulo}"
            extras = dict(comum)
            if tela == "visao-geral":
                extras["cfg"] = cfg_frota(f"{nome} — equipamentos", True)
                def aj(d):
                    links_alvos(painel(d, 90)); frota_alvos(painel(d, 1), True)
            elif tela == "equipamentos":
                extras["cfg"] = cfg_frota(f"{nome} — equipamentos", False)
                def aj(d):
                    frota_alvos(painel(d, 1), False)
            elif tela == "mapa":
                extras["topo"] = topo(s); extras["mapa_nuvem"] = mapa_nuvem(cfg, s)
                def aj(d):
                    p = painel(d, 1); novos = []
                    for t in p["targets"]:
                        r = t["refId"]
                        if r == "A":
                            novos.append(alvo(t, group="/.*/", host=rx_hosts(site_hosts)))
                        elif r == "N":
                            novos.append(alvo(t, group=f"/^({GRUPOS_SERVIDORES}|Rede\\/Firewall)$/"))
                        elif r == "I":
                            novos.append(alvo(t, group="/.*/", host=rx_hosts([rtr] + switches)))
                        else:
                            novos.append(t)
                    p["targets"] = novos
            elif tela == "links":
                def aj(d):
                    links_alvos(painel(d, 1))
            elif tela == "switches":
                g = rx_grupos([f"{nome}/Switches"])
                def aj(d, g=g):
                    p = painel(d, 1)
                    p["targets"] = [alvo(t, group=g) for t in p["targets"]]
                    for v in d.get("templating", {}).get("list", []):
                        if v.get("name") == "switch":
                            v["query"]["group"] = g; v["definition"] = f"Zabbix hosts: grupo {g}"
            elif tela == "quedas":
                def aj(d):
                    p = painel(d, 1)
                    p["targets"] = [alvo(t, group="/.*/", host=rx_hosts([h for h in site_hosts if not h.startswith("LINK-")]),
                                         item="/^ICMP: disponível$|^ICMP ping$|^Túnel até a RB: disponível$|^Gateway d[oa] (site|sede) \\(via túnel\\): disponível$/")
                                    for t in p["targets"]]
            out[uid(cfg, sid, tela)] = montar_dashboard(cfg, "site-" + tela, sid, tela, titulo, extras, aj)
    if nv:
        ips = {}
        for x in ([nv["firewall"]] if nv["firewall"] else []) + nv["outros_firewalls"] + nv["servidores"] + nv["fora"]:
            if x.get("ip"):
                ips[x["host"]] = x["ip"]
        for s in cfg["sites"]:
            ips[s["roteador"]["host"]] = s["roteador"]["ip"]
        extras = {"ips": ips, "detalhe_uid": uid(cfg, "nuvem", "detalhe"), "vpn_host": nv["vpn"] or ""}
        nada = lambda d: None
        out[uid(cfg, "nuvem", "servidores")] = montar_dashboard(cfg, "nuvem-servidores", "nuvem", "servidores", f"{cfg['empresa']} {nv['nome']} — Servidores", extras, nada)
        out[uid(cfg, "nuvem", "detalhe")] = montar_dashboard(cfg, "nuvem-detalhe", "nuvem", "detalhe", f"{cfg['empresa']} {nv['nome']} — Detalhe do servidor", extras, nada)
        if nv["vpn"]:
            h = rx_hosts([nv["vpn"]])
            def aj(d):
                p = painel(d, 1); p["targets"] = [alvo(t, host=h) for t in p["targets"]]
            out[uid(cfg, "nuvem", "vpn")] = montar_dashboard(cfg, "nuvem-vpn", "nuvem", "vpn", f"{cfg['empresa']} {nv['nome']} — Acessos VPN", extras, aj)
    return out


# ----------------------------------------------------------------------------------------------------- Zabbix
def tpl_internet(s):
    """Template "NOC - Internet <site>": um item por link (IP sentinela) e o túnel."""
    nome = f"NOC - Internet {s['nome']}"
    t = {"uuid": u4("tpl-inet-" + s["id"]), "template": nome, "name": nome, "groups": [{"name": "Templates/NOC"}],
         "description": (f"Internet por link do roteador {s['roteador']['host']} ({s['nome']}), testada pelo próprio roteador "
                         "(Netwatch + rota fixa para a sonda) e lida pelo Zabbix via IPs sentinela. Gerado pelo noc.py; o script do "
                         f"roteador está em saida/mikrotik/{s['id']}.rsc."),
         "items": [], "macros": [], "tags": [{"tag": "area", "value": "rede"}, {"tag": "site", "value": s["id"]}],
         "valuemaps": [{"uuid": u4("vm-inet-" + s["id"]), "name": "NOC Internet",
                        "mappings": [{"value": "0", "newvalue": "Sem internet"}, {"value": "1", "newvalue": "Com internet"}]}]}
    trg = []
    tun = s["tunel"]
    if tun:
        t["items"].append({"uuid": u4(f"it-tun-{s['id']}"), "name": "Túnel até a RB: disponível", "type": "SIMPLE", "key": "icmpping[{$RB.TUNEL.IP},3]",
                           "delay": "30s", "history": "14d", "valuemap": {"name": "NOC Internet"}, "tags": [{"tag": "component", "value": "sentinela"}],
                           "description": "Ping ao IP do roteador dentro do túnel. Sem túnel o Zabbix não enxerga o site: os alertas do site ficam suprimidos (o alerta é o do túnel)."})
        t["macros"].append({"macro": "{$RB.TUNEL.IP}", "value": tun["ip"], "description": "IP do roteador dentro do túnel."})
        trg.append({"uuid": u4(f"trg-tun-{s['id']}"), "name": f"Túnel até {s['nome']} fora",
                    "expression": f"max(/{nome}/icmpping[{{$RB.TUNEL.IP}},3],#3)=0", "priority": "HIGH",
                    "event_name": f"{{HOST.NAME}}: túnel até {s['nome']} fora - equipamentos do site sem monitoramento",
                    "description": (f"O Zabbix não alcança o roteador de {s['nome']} pelo túnel (3 coletas). Sem túnel, nada do site é visto: os alertas dos "
                                    "equipamentos dependem deste e ficam suprimidos. Verifique a internet do site e a VPN no firewall da nuvem."),
                    "tags": [{"tag": "scope", "value": "availability"}, {"tag": "link", "value": "tunel"}]})
    outros = [l["nome"] for l in s["links"]]
    for l in s["links"]:
        k = f"icmpping[{{$SENT.{l['nome']}}},3]"
        t["items"].append({"uuid": u4(f"it-wan-{s['id']}-{l['nome']}"), "name": f"WAN {l['nome']}: internet", "type": "SIMPLE", "key": k,
                           "delay": "30s", "history": "30d", "valuemap": {"name": "NOC Internet"}, "tags": [{"tag": "component", "value": "internet"}],
                           "description": f"1 = o roteador tem internet pelo link {l['nome']}. O Netwatch pinga {l['sonda']}, que só sai por este link, e liga/desliga o IP sentinela {{$SENT.{l['nome']}}}."})
        t["macros"].append({"macro": f"{{$SENT.{l['nome']}}}", "value": l["sentinela"], "description": f"IP sentinela do link {l['nome']} (ligado = com internet)."})
        resto = [x for x in outros if x != l["nome"]]
        cond = f" and min(/{nome}/icmpping[{{$RB.TUNEL.IP}},3],#3)=1" if tun else ""
        trg.append({"uuid": u4(f"trg-wan-{s['id']}-{l['nome']}"), "name": f"{l['nome']} sem internet",
                    "expression": f"max(/{nome}/{k},#3)=0{cond}", "recovery_mode": "RECOVERY_EXPRESSION",
                    "recovery_expression": f"min(/{nome}/{k},#2)=1", "priority": "HIGH",
                    "event_name": f"{{HOST.NAME}}: link {l['nome']} sem internet" + (f" - {s['nome']} saindo por {', '.join(resto)}" if resto else f" - {s['nome']} sem internet"),
                    "description": (f"A sonda {l['sonda']} não responde pelo link {l['nome']} há 3 coletas" + (" (túnel no ar)" if tun else "") +
                                    ". Verifique o link e a operadora. Fecha só quando a sentinela responder 2 vezes seguidas (o túnel piscar não fecha nem reabre o alerta)."),
                    "tags": [{"tag": "scope", "value": "availability"}, {"tag": "link", "value": l["nome"]}]})
    return t, trg


def ifcontrol(portas):
    nums = sorted({str(p) for p in portas if str(p).isdigit()}, key=int)
    nomes = sorted({str(p) for p in portas if not str(p).isdigit()})
    alts = ([f"(^|[^0-9])({'|'.join(nums)})[^0-9]*$"] if nums else []) + [f"^{re.escape(n)}$" for n in nomes]
    if not alts:
        return []
    rx = "|".join(f"({a})" for a in alts) if len(alts) > 1 else alts[0]
    d = "Gerado pelo noc.py: Link down só nas portas que aparecem no mapa."
    return [{"macro": "{$IFCONTROL}", "value": "0", "description": d}, {"macro": '{$IFCONTROL:regex:"' + rx + '"}', "value": "1", "description": d}]


def zabbix(cfg):
    grupos, hosts, tpls, trgs = set(), [], [], []
    snmp = cfg["snmp_macro"]

    def iface(tipo, ip):
        if tipo == "SNMP":
            return [{"type": "SNMP", "ip": ip, "port": "161", "useip": "YES", "default": "YES",
                     "details": {"version": "SNMPV2", "community": snmp, "bulk": "YES"}, "interface_ref": "if1"}]
        return [{"type": "ZABBIX", "ip": ip, "port": "10050", "useip": "YES", "default": "YES", "interface_ref": "if1"}]

    def host(h, gs, tl, tipo_if, ip, tags, macros=None, desc=""):
        grupos.update(gs)
        x = {"host": h, "name": h, "templates": [{"name": t} for t in tl], "groups": [{"name": g} for g in gs],
             "interfaces": iface(tipo_if, ip), "tags": tags, "inventory_mode": "DISABLED"}
        if desc:
            x["description"] = desc
        if macros:
            x["macros"] = macros
        hosts.append(x)

    for s in cfg["sites"]:
        N, sid = s["nome"], s["id"]
        t, tr = tpl_internet(s)
        tpls.append(t); trgs.extend(tr)
        tags = lambda tipo: [{"tag": "site", "value": sid}, {"tag": "tipo", "value": tipo}]
        gw = [{"macro": "{$SITE.GW}", "value": s["gateway"], "description": "Gateway da rede do site: sentinela do caminho até o site."}]
        # portas usadas no mapa, por equipamento (para o Link down)
        portas = {}
        for e in s["equip"]:
            if e["pai"] and e["porta_pai"] != "wifi":
                portas.setdefault(e["pai"], set()).add(e["porta_pai"])
            if e["porta"] not in (None, ""):
                portas.setdefault(e["id"], set()).add(e["porta"])
        for c in s["cams"]:
            if c["pai"]:
                portas.setdefault(c["pai"], set()).add(c["porta_pai"])
        for l in s["links"]:
            portas.setdefault("RTR", set()).add(l["interface"])
        r = s["roteador"]
        tl = (["Mikrotik by SNMP"] if r["mikrotik"] else ["Network Generic Device by SNMP"]) + [t["template"]]
        mac = ifcontrol(portas.get("RTR", []))
        dl = [l for l in s["links"] if l["dhcp_faixa"]]
        if dl:
            tl.append("NOC - MikroTik WAN DHCP")
            mac += [{"macro": "{$WAN.DHCP.NOME}", "value": dl[0]["nome"]}, {"macro": "{$WAN.DHCP.PREFIX}", "value": dl[0]["dhcp_faixa"]}]
        host(r["host"], ["Rede/Roteadores", f"{N}/Rede"], tl, "SNMP", r["ip"], tags("roteador"), mac,
             f"Roteador de borda de {N}" + (f" ({r['modelo']})" if r["modelo"] else "") + ". Gerado pelo noc.py.")
        for l in s["links"]:
            if not l["ip_publico"]:
                continue
            mac = [{"macro": "{$LINK.IP}", "value": l["ip_publico"]}, {"macro": "{$LINK.GW}", "value": l["gateway"] or l["ip_publico"]},
                   {"macro": "{$VPN.IP}", "value": s["tunel"]["ip"] if s["tunel"] else l["ip_publico"]}]
            host("LINK-" + l["nome"], ["Rede/Links", f"{N}/Rede"], ["NOC - Link WAN"], "AGENT", l["ip_publico"], tags("link"), mac,
                 f"Link {l['nome']} de {N} visto de fora (ping do IP público). Gerado pelo noc.py.")
        for e in s["equip"]:
            tpl = "NOC - AP Grandstream GWN" if e["tipo"] == "ap" and "grandstream" in e["modelo"].lower() else \
                  ("NOC - Dispositivo (ping)" if e["tipo"] == "ap" else TEMPLATE[e["tipo"]])
            snmp_if = e["tipo"] in SNMP_TIPOS or tpl == "NOC - AP Grandstream GWN"
            mac = list(gw)
            if e["tipo"] == "switch":
                mac += ifcontrol(portas.get(e["id"], []))
            if e["tipo"] == "acesso" and e["porta_servico"]:
                mac.append({"macro": "{$SVC.PORT}", "value": str(e["porta_servico"])})
            host(e["host"], [f"{N}/{CATEGORIA[e['tipo']]}"], [tpl], "SNMP" if snmp_if else "AGENT", e["ip"], tags(e["tipo"]), mac)
        for c in s["cams"]:
            host(c["host"], [f"{N}/CFTV/Cameras"], [TEMPLATE["camera"]], "AGENT", c["ip"], tags("camera"), list(gw))
    hosts_yaml = {"zabbix_export": {"version": "7.4", "host_groups": [{"uuid": u4("hg-" + g), "name": g} for g in sorted(grupos)], "hosts": hosts}}
    tpl_yaml = {"zabbix_export": {"version": "7.4", "template_groups": [{"uuid": u4("tg-noc"), "name": "Templates/NOC"}],
                                  "templates": tpls, "triggers": trgs}}
    return tpl_yaml, hosts_yaml


def mikrotik(s):
    r = s["roteador"]
    ln = [f"# {s['nome']} ({r['host']}): IPs sentinela e Netwatch para o Zabbix saber, link a link, se o roteador tem internet.",
          "# Gerado pelo noc.py. REVISE ANTES DE COLAR, use Safe Mode (Ctrl+X) e cole uma linha por vez se tiver dúvida.",
          "# Como funciona: cada link tem uma 'sonda' (IP na internet) com rota fixa só por aquele link. O Netwatch pinga a sonda",
          "# e liga/desliga um IP 'sentinela' na LAN. O Zabbix pinga a sentinela pelo túnel: responde = o link tem internet.",
          f"# A sentinela fica na interface '{r['lan']}' (campo roteador.lan do noc.yaml).", ""]
    for l in s["links"]:
        c = f"NOC {l['nome']}"
        ln += [f"# --- link {l['nome']} ({l['interface']})",
               f'/ip address add address={l["sentinela"]}/32 interface={r["lan"]} disabled=yes comment="{c} sentinela"']
        if l["interface"].lower().startswith(("pppoe", "l2tp", "pptp", "sstp", "ovpn", "lte")):
            ln.append(f'/ip route add dst-address={l["sonda"]}/32 gateway={l["interface"]} comment="{c} sonda"')
        else:
            ln.append(f'# troque GATEWAY_DA_OPERADORA pelo gateway do link {l["nome"]} (em /ip route print, a rota padrão deste link):')
            ln.append(f'/ip route add dst-address={l["sonda"]}/32 gateway=GATEWAY_DA_OPERADORA comment="{c} sonda"')
        ln.append(f'/tool netwatch add host={l["sonda"]} interval=10s timeout=2s comment="{c} internet" '
                  f'up-script="/ip address enable [find comment=\\"{c} sentinela\\"]" '
                  f'down-script="/ip address disable [find comment=\\"{c} sentinela\\"]"')
        ln.append("")
    ln += ["# Conferir: /ip address print where comment~\"NOC\"   e   /tool netwatch print"]
    return "\n".join(ln) + "\n"


# ----------------------------------------------------------------------------------------------------- comandos
def resumo(cfg):
    print(f"Empresa: {cfg['empresa']}")
    if cfg["nuvem"]:
        n = cfg["nuvem"]
        print(f"  {n['nome']}: firewall {n['firewall']['host'] if n['firewall'] else '-'}, {len(n['servidores'])} servidor(es)"
              + (f", tela VPN ({n['vpn']})" if n["vpn"] else ""))
    for s in cfg["sites"]:
        tipos = {}
        for e in s["equip"]:
            tipos[e["tipo"]] = tipos.get(e["tipo"], 0) + 1
        eq = ", ".join(f"{v} {k}" for k, v in sorted(tipos.items()))
        print(f"  {s['nome']} ({s['id']}): roteador {s['roteador']['host']}, links {', '.join(l['nome'] for l in s['links']) or '-'}, "
              f"{'túnel' if s['tunel'] else 'sem túnel'}; {eq or 'sem equipamentos'}; {len(s['cams'])} câmera(s)")
    for a in cfg["_avisos"]:
        print("  AVISO:", a)


def cmd_gerar(cfg, pasta):
    yaml = yaml_mod()
    dump = lambda o: yaml.safe_dump(o, allow_unicode=True, sort_keys=False, width=10 ** 6)
    if os.path.isdir(pasta):
        for sub in ("grafana", "zabbix", "mikrotik"):
            shutil.rmtree(os.path.join(pasta, sub), ignore_errors=True)
    ds = dashboards(cfg)
    for i, (u, d) in enumerate(ds.items()):
        gravar(os.path.join(pasta, "grafana", f"{u}.json"), json.dumps(d, ensure_ascii=False, indent=2) + "\n")
    os.makedirs(os.path.join(pasta, "zabbix"), exist_ok=True)
    shutil.copy(os.path.join(RAIZ, "zabbix", "templates", "noc-templates.yaml"), os.path.join(pasta, "zabbix", "1-templates-noc.yaml"))
    tpl, hs = zabbix(cfg)
    gravar(os.path.join(pasta, "zabbix", "2-templates-internet-sites.yaml"), dump(tpl))
    gravar(os.path.join(pasta, "zabbix", "3-hosts.yaml"), dump(hs))
    for s in cfg["sites"]:
        if s["roteador"]["mikrotik"]:
            gravar(os.path.join(pasta, "mikrotik", f"{s['id']}.rsc"), mikrotik(s))
    n_hosts = len(hs["zabbix_export"]["hosts"])
    leia = [f"Gerado pelo noc.py para {cfg['empresa']}.", "",
            "ZABBIX (Data collection -> Templates/Hosts -> Import, nesta ordem, SEM marcar \"Delete missing\"):",
            "  zabbix/1-templates-noc.yaml            templates genéricos (Switch, AP, Câmera, NVR, Link WAN, pfSense...)",
            "  zabbix/2-templates-internet-sites.yaml um template de internet por site (links e túnel)",
            f"  zabbix/3-hosts.yaml                    {n_hosts} hosts dos sites (roteadores, links, switches, APs, câmeras...)",
            "  Depois: crie a macro global " + cfg["snmp_macro"] + " (Secret text) com a community SNMP.",
            "  E rode: python noc.py dependencias --aplicar   (um alerta por queda, não um por equipamento)", "",
            "GRAFANA (Dashboards -> New -> Import, um arquivo por vez, escolhendo o datasource do Zabbix):"]
    leia += [f"  grafana/{u}.json   {d['title']}" for u, d in ds.items()]
    if any(s["roteador"]["mikrotik"] for s in cfg["sites"]):
        leia += ["", "MIKROTIK: mikrotik/<site>.rsc tem os IPs sentinela e o Netwatch de cada link. Revise e cole em Safe Mode."]
    gravar(os.path.join(pasta, "LEIAME.txt"), "\n".join(leia) + "\n")
    resumo(cfg)
    print(f"\nGerado em {pasta}/: {len(ds)} tela(s) do Grafana, {n_hosts} host(s) do Zabbix. Próximos passos em {pasta}/LEIAME.txt")


def api(url, token, metodo, params, _id=[0]):
    _id[0] += 1
    corpo = json.dumps({"jsonrpc": "2.0", "method": metodo, "params": params, "id": _id[0]}).encode()
    cab = {"Content-Type": "application/json-rpc"}
    if metodo != "apiinfo.version":
        cab["Authorization"] = "Bearer " + token
    r = json.load(urllib.request.urlopen(urllib.request.Request(url, corpo, cab), timeout=30))
    if "error" in r:
        raise Erro(f"API {metodo}: {r['error'].get('message')} {r['error'].get('data')}")
    return r["result"]


def cmd_dependencias(cfg, aplicar):
    url = os.environ.get("ZBX_URL", "http://127.0.0.1/zabbix/api_jsonrpc.php")
    token = os.environ.get("ZBX_TOKEN", "")
    if not token:
        raise Erro("defina ZBX_TOKEN com um token de API do Zabbix (Users -> API tokens).\n"
                   "  Linux:   read -s ZBX_TOKEN; export ZBX_TOKEN\n  Windows: set ZBX_TOKEN=...   (no PowerShell: $env:ZBX_TOKEN=\"...\")")
    A = lambda m, p: api(url, token, m, p)
    print("Zabbix API", A("apiinfo.version", {}), "em", url, "| modo:", "APLICAR" if aplicar else "SIMULAÇÃO (nada é gravado)")
    PAI_TRG = "Sem resposta ao ping"
    total = 0
    for s in cfg["sites"]:
        print(f"\n== {s['nome']}")
        id_host = {"RTR": s["roteador"]["host"]}
        id_host.update({e["id"]: e["host"] for e in s["equip"]})
        pai = {e["host"]: (id_host[e["pai"]] if e["pai"] and e["pai"] != "RTR" else None) for e in s["equip"]}
        pai.update({c["host"]: (id_host[c["pai"]] if c["pai"] and c["pai"] != "RTR" else None) for c in s["cams"]})
        nomes = sorted(set(pai) | {p for p in pai.values() if p} | {s["roteador"]["host"]})
        hosts = {h["name"]: h for h in A("host.get", {"output": ["hostid", "name"], "filter": {"name": nomes}})}
        falta = [n for n in nomes if n not in hosts]
        if falta:
            print("  AVISO: não estão no Zabbix (pulados):", ", ".join(falta[:15]) + (" …" if len(falta) > 15 else ""))
        ping = {}
        for n in nomes:
            if n in hosts:
                t = A("trigger.get", {"output": ["triggerid"], "hostids": hosts[n]["hostid"], "filter": {"description": PAI_TRG}})
                if len(t) == 1:
                    ping[n] = t[0]["triggerid"]
        tun_id = None
        if s["tunel"] and s["roteador"]["host"] in hosts:
            t = A("trigger.get", {"output": ["triggerid"], "hostids": hosts[s["roteador"]["host"]]["hostid"],
                                  "filter": {"description": f"Túnel até {s['nome']} fora"}})
            tun_id = t[0]["triggerid"] if len(t) == 1 else None
            if not tun_id:
                print(f"  AVISO: trigger 'Túnel até {s['nome']} fora' não encontrado; importe o 2-templates-internet-sites.yaml")
        todos_ping = set(ping.values())
        mud = 0
        for filho in sorted(pai):
            if filho not in hosts:
                continue
            quero = [ping[pai[filho]]] if pai[filho] in ping else []
            if tun_id:
                quero.append(tun_id)
            for t in A("trigger.get", {"output": ["triggerid", "description", "flags"], "hostids": hosts[filho]["hostid"], "selectDependencies": ["triggerid"]}):
                if str(t["flags"]) == "4":
                    continue      # descoberto por LLD: o Zabbix não aceita dependência
                deps = [d["triggerid"] for d in t["dependencies"]]
                proprio = ping.get(filho)
                velhos = [x for x in deps if x in todos_ping and x not in quero and x != t["triggerid"] and x != proprio]
                novo = [x for x in deps if x not in velhos] + [x for x in quero if x not in deps and x != t["triggerid"]]
                if proprio and proprio != t["triggerid"] and re.search(r"Unavailable by ICMP ping", t["description"], re.I) and proprio not in novo:
                    novo.append(proprio)      # ping do template genérico depende do nosso: equipamento fora = 1 alerta
                if novo == deps:
                    continue
                mud += 1
                print(f"  {filho}: '{t['description']}' -> depende de " + ", ".join(
                    ("túnel" if x == tun_id else next((h for h, v in ping.items() if v == x), x)) for x in novo if x not in deps))
                if aplicar:
                    A("trigger.update", {"triggerid": t["triggerid"], "dependencies": [{"triggerid": x} for x in novo]})
        print(f"  {mud} trigger(s) {'atualizado(s)' if aplicar else 'a atualizar'}")
        total += mud
    if total and not aplicar:
        print("\nNada foi gravado. Rode de novo com --aplicar.")


def main(argv):
    args = list(argv)
    conf, pasta = "noc.yaml", "saida"
    if "-c" in args:
        i = args.index("-c"); conf = args[i + 1]; del args[i:i + 2]
    if "-o" in args:
        i = args.index("-o"); pasta = args[i + 1]; del args[i:i + 2]
    if not args or args[0] not in ("validar", "gerar", "dependencias"):
        print(__doc__)
        return 1
    try:
        cfg = carregar(conf)
        if args[0] == "validar":
            resumo(cfg)
            print(f"\n{conf}: tudo certo. Rode 'python noc.py gerar'.")
        elif args[0] == "gerar":
            cmd_gerar(cfg, pasta)
        else:
            cmd_dependencias(cfg, "--aplicar" in args)
    except Erro as e:
        print("ERRO:", e)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
