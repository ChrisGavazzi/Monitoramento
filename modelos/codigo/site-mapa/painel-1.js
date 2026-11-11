/* MAPA DA REDE - Business Text (afterRender)
 * Topologia DECLARADA abaixo (TOPO), colorida pelos dados do Zabbix:
 *   A = disponibilidade (ICMP / SNMP) e DHCP do link por DHCP     I = interfaces (status, tráfego, velocidade)
 *   F = problemas
 * Ligação = porta "de" no equipamento de cima (pai). Porta numérica casa com o número no fim do nome da interface
 * (Gi1/0/25, gi0/25, ge25 -> 25); porta com nome (ether3, pppoe-...) casa pelo nome exato.
 * Clique num equipamento: destaca o caminho até a internet e mostra o que depende dele. Clique no fundo: limpa.
 * PARA MUDAR A TOPOLOGIA: edite TOPO (nós e ligações). Ligação sem fio: pde: "wifi" (ex.: { de: "AP05", pde: "wifi", para: "ACE09" }); desenhada pontilhada em ciano. Cabeamento conferido por LLDP em 2026-10-21.
 * Modelos: SG 2404 PoE Max (porta "GigabitEthernet0/N"), SG 2404 PoE L2+ ("gigabitEthernet 1/0/N : copper|fiber"), SG 2404D PoE Max ("geN").
 */
/* TOPO e NUVEM vêm do noc.yaml (o gerador monta a partir de "sites" e "nuvem"). Formato:
 *   TOPO  = { raiz, nos: [{ id, tipo, host, nome, sub }], links: [{ de, pde, para, ppara, trunk, wifi }], areas: [{ id, nome, curto, raiz }],
 *             cams: [{ sw, p, host, rotulo }] }
 *   NUVEM = { fw, nome, sub, tunIf, via: [links], fora: [], wan: [hosts], firewalls: [{ fw, nome, hosts }], info: { host: { so, ip, desc } } }
 */
const TOPO = NOC.topo;
const NUVEM = NOC.mapa_nuvem;
const SITE = NOC.site_nome, RTRH = NOC.rtr;   // nome do site e host do roteador de borda
// etiquetas de sistema (texto, sem logotipos): equipamento da sede usa o campo so: em TOPO
const SO = { win: ["WIN", "#60a5fa"], linux: ["LINUX", "#fbbf24"], ubuntu: ["UBUNTU", "#fb923c"], bsd: ["pfSense", "#2dd4bf"], ros: ["RouterOS", "#f472b6"], asustor: ["ASUSTOR", "#a3e635"] };
/* IMAGEM DO SISTEMA (opcional): URL de uma imagem fornecida por vocês (SVG ou PNG quadrado, fundo transparente).
 * Preenchida = a imagem aparece no círculo do cartão, no lugar do ícone (o selo de texto some). Vazia = ícone + selo de texto.
 * A URL precisa abrir no navegador de quem vê o painel (ex.: arquivo num servidor web interno). */
const IMG_BASE = ((window.grafanaBootData && grafanaBootData.settings && grafanaBootData.settings.appSubUrl) || "") + "/public/img/kestrel/svg/";   // /usr/share/grafana/public/img/kestrel/svg (cópia em /home/kestrel/svg)
const SO_IMG = NOC.so_img || {};   // opcional: { win: "windows.svg", ... } em IMG_BASE
// imagem do cartão: a do próprio equipamento (campo img: em TOPO ou NUVEM.info), senão a do sistema; caminho relativo = pasta acima
const imgDe = n => { const f = n.img || (n.so && SO_IMG[n.so]) || ""; return !f ? "" : /^(https?:|data:|\/)/.test(f) ? f : IMG_BASE + f; };
const SEDE_HOSTS = { test: h => NOC.hosts[h] === NOC.grupo };   // hosts deste site (do noc.yaml)
const UTIL_ATENCAO = 70, UTIL_CRITICO = 90;   // % da velocidade da porta

/* --- compatibilidade / helpers --- */
const ctx = (typeof context !== "undefined") ? context : {};
const root0 = ctx.element || (typeof element !== "undefined" ? element : document);
const root = (root0.querySelector && root0.querySelector(".noc")) || root0;
const isFrames = a => Array.isArray(a) && a.length && a[0] && Array.isArray(a[0].fields);
function findSeries(o, d, seen) {
  if (!o || typeof o !== "object" || d > 4 || seen.has(o)) return null; seen.add(o);
  if (isFrames(o.series)) return o.series; if (isFrames(o)) return o;
  for (const k of ["panel", "panelData", "data", "series"]) { const r = findSeries(o[k], d + 1, seen); if (r) return r; }
  return null;
}
const series = findSeries(ctx, 0, new Set()) || (typeof panelData !== "undefined" ? findSeries(panelData, 0, new Set()) : null) || [];
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const vals = f => !f ? [] : (Array.isArray(f.values) ? f.values : (f.values && f.values.toArray ? f.values.toArray() : []));
const lastNN = a => { for (let i = a.length - 1; i >= 0; i--) if (a[i] != null && !Number.isNaN(a[i])) return a[i]; return null; };
const sName = (fr, f) => { const c = f.config || {}; return c.displayNameFromDS || c.displayName || fr.name || f.name || ""; };
const hostOf = (f, n) => { const l = f.labels || {}; return l.host || l.host_name || (n.includes(": ") ? n.split(": ")[0] : n); };
const itemOf = (f, n) => { const l = f.labels || {}; return l.item || (n.includes(": ") ? n.split(": ").slice(1).join(": ") : n); };
const bps = b => { if (b == null) return "—"; const u = ["bps", "Kbps", "Mbps", "Gbps"]; let i = 0; while (b >= 1000 && i < 3) { b /= 1000; i++; } return (i && b < 100 ? b.toFixed(1) : b.toFixed(0)) + " " + u[i]; };
const kb = b => bps(b).replace(" Kbps", "K").replace(" Mbps", "M").replace(" Gbps", "G").replace(" bps", "");
const age = ts => { if (!ts) return ""; let x = Math.floor(Date.now() / 1000 - ts); const d = Math.floor(x / 86400), h = Math.floor(x % 86400 / 3600), m = Math.floor(x % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
const SEV = ["N/C", "Info", "Warning", "Average", "High", "Disaster"], SEVC = ["#6b7280", "#38bdf8", "#f5b301", "#fb923c", "#ef4444", "#b91c1c"];

/* --- leitura --- */
const HOST = {}, debug = [];
let problems = [], newest = 0;
const hs = h => (HOST[h] = HOST[h] || { ping: null, snmp: null, dhcp: null, inet: {}, ifs: {} });
for (const fr of series) {
  const ref = fr.refId || "";
  const tf = (fr.fields || []).find(f => f.type === "time");
  if (tf && ref !== "F") { const t = lastNN(vals(tf)); if (t > newest) newest = t; }
  const tv = tf ? vals(tf) : [];
  for (const f of fr.fields || []) {
    const v = vals(f);
    debug.push(`[${ref}] ${sName(fr, f)} n=${v.length}`);
    if (ref === "F") { if (v.length && typeof v[0] === "object" && v[0] !== null) problems = problems.concat(v); continue; }
    if (f.type !== "number") continue;
    const nm = sName(fr, f), h = hostOf(f, nm), it = itemOf(f, nm), x = lastNN(v);
    if (!h) continue;
    if (ref === "N" && (SEDE_HOSTS.test(h) || NUVEM.fora.includes(h))) continue;   // N = servidores; os da sede já vêm em A
    const o = hs(h);
    if (ref === "N") {
      o.nuvem = true;
      if (/^ICMP: disponível$|ICMP ping$/i.test(it)) o.ping = x;
      else if (/SNMP agent availability/i.test(it)) { o.snmp = x; o.snmpH = { t: tv, v }; }
      else if (/Zabbix agent availability/i.test(it)) { o.ag = x; o.agH = { t: tv, v }; }
    } else if (ref === "A") {
      if (/^ICMP: disponível$|ICMP ping$/i.test(it)) o.ping = x;
      else if (/SNMP agent availability/i.test(it)) { o.snmp = x; o.snmpH = { t: tv, v }; }
      else if (/DHCP client com IP/i.test(it)) o.dhcp = x;
      else if (/Túnel até a RB/i.test(it)) { o.tun = x; o.tunH = { t: tv, v }; }
      else { const ni = it.match(/^WAN\s+(.+?):\s*internet\b/i); if (ni) o.inet[ni[1].trim().toUpperCase()] = x; }
    } else if (ref === "I") {
      // "Interface GigabitEthernet0/25: ...", "Interface gigabitEthernet 1/0/25 : fiber: ...", "Interface ge25: ...", "Interface ether3(alias): ..."
      const m = it.match(/^Interface\s+(.+):\s*(Operational status|Bits received|Bits sent|Speed)$/i);
      if (!m || /\{#/.test(m[1])) continue;
      const pn = m[1].replace(/\s*:\s*(copper|fiber)\s*$/i, "").replace(/\(.*\)\s*$/, "").trim(), met = m[2];
      const p = o.ifs[pn] = o.ifs[pn] || { n: pn, st: null, rx: null, tx: null, sp: null };
      if (/Operational status/i.test(met)) p.st = x;
      else if (/Bits received/i.test(met)) p.rx = x;
      else if (/Bits sent/i.test(met)) p.tx = x;
      else if (/Speed/i.test(met)) p.sp = x;
    }
  }
}
/* --- MESMO TEMPO PARA TODOS ---
 * Cada coisa chega num ritmo: ping a cada 30 s; disponibilidade de SNMP e do agente demora minutos para cair e para voltar
 * (o Zabbix espera várias falhas e depois só tenta de novo de tempos em tempos). Misturar os dois dava RB vermelha com tudo verde,
 * ou NAS verde com tudo fora. Regras:
 *  1) "fora" é decidido pelo PING (30 s). A RB não tem ping próprio: vale o ping do túnel até ela (mesmo ritmo dos outros).
 *  2) SNMP/agente sem resposta com o ping ok só vira alerta depois de SNMP_MIN_MIN minutos seguidos (antes disso é atraso do Zabbix).
 *  3) Depois que o túnel volta, CARENCIA_MIN minutos de "atualizando": quem ainda aparece fora é valor velho, não queda. */
const SNMP_MIN_MIN = 3, CARENCIA_MIN = 2;
const durou = (Hh, ok) => { if (!Hh || !Hh.v || !Hh.v.length) return 0; let i = Hh.v.length - 1; while (i >= 0 && Hh.v[i] == null) i--;
  if (i < 0 || !ok(Hh.v[i])) return 0; let j = i; while (j > 0 && (Hh.v[j - 1] == null || ok(Hh.v[j - 1]))) j--; return Date.now() - Number(Hh.t[j]); };
const haQuanto = (Hh, ok) => { if (!Hh || !Hh.v) return Infinity; for (let i = Hh.v.length - 1; i >= 0; i--) if (Hh.v[i] != null && ok(Hh.v[i])) return Date.now() - Number(Hh.t[i]); return Infinity; };
{ const rbHost = (TOPO.nos.find(n => n.id === TOPO.raiz) || {}).host, o = HOST[rbHost];
  if (o && o.ping == null && o.tun != null) { o.ping = o.tun; o.pingDoTunel = true; } }
const P = problems.map(p => { const h0 = p.hosts && p.hosts[0]; let ts = Number(p.lastchange || p.timestamp || 0); if (ts > 1e12) ts /= 1000;
  const mt = p.suppressed == 1 || p.suppressed === "1" || !!(h0 && h0.maintenance_status == 1);
  return { h: (h0 && (h0.name || h0.host)) || p.host || "?", p: p.name || p.description || "", sev: Number(p.severity != null ? p.severity : p.priority) || 0, ts, mt }; })
  .filter(p => !p.mt && (SEDE_HOSTS.test(p.h) || (HOST[p.h] && HOST[p.h].nuvem)));   // F traz tudo; ficam os da sede e os da nuvem do mapa

/* --- portas --- */
const NONPORT = /vlan|loop|null|cpu|lo\d|bridge|tunnel|ovpn|pppoe/i;
function porta(host, ref) {
  const o = HOST[host]; if (!o || ref == null) return null;
  if (typeof ref === "string") { const k = Object.keys(o.ifs).find(n => n.toLowerCase() === ref.toLowerCase()); return k ? o.ifs[k] : null; }
  const c = Object.values(o.ifs).filter(p => !NONPORT.test(p.n) && Number((p.n.match(/(\d+)\s*$/) || [])[1]) === ref);
  return c.sort((a, b) => (b.st === 1) - (a.st === 1))[0] || null;
}

/* --- filtros (ficam guardados neste navegador) --- */
const S = window.__mapaState = window.__mapaState || {};
if (!S.f) { let f = null; try { f = JSON.parse(localStorage.getItem("mapaSedeFiltro") || "null"); } catch (e) {}
  S.f = Object.assign({ ap: true, acesso: true, nvr: true, cam: "cont", soProb: false, rot: true, area: "tudo", srv: true, side: true, fluxo: true }, f || {}); }
const AREAS = TOPO.areas || [];
if (S.f.area !== "tudo" && S.f.area !== "sede" && !AREAS.some(a => a.id === S.f.area)) S.f.area = "tudo";
const salvaF = () => { try { localStorage.setItem("mapaSedeFiltro", JSON.stringify(S.f)); } catch (e) {} };

function desenhar() {
S.camAbre = S.camAbre || {};                       // switches com as câmeras abertas (clique no contador)
const camNo = sw => S.f.cam === "det" || (S.f.cam === "cont" && !!S.camAbre[sw]);
const T = { raiz: TOPO.raiz, cams: TOPO.cams || [], nos: TOPO.nos.slice(), links: TOPO.links.slice() };
// câmeras "uma a uma": viram caixas ligadas na porta do switch
T.cams.forEach(c => { if (!camNo(c.sw)) return; const id = "C_" + c.host, o = c.rotulo || c.host;
  T.nos.push({ id, tipo: "camera", host: c.host, nome: "Câmera ." + o, sub: "192.168.30." + o }); T.links.push({ de: c.sw, pde: c.p, para: id }); });
// nuvem: o pfSense sempre aparece; os servidores viram caixas só com o contador aberto (clique em "servidores N")
const FWH = NUVEM.fw, SRVH = Object.keys(HOST).filter(h => HOST[h].nuvem && h !== FWH).sort((a, b) => a.localeCompare(b));
const temNuvem = !!(HOST[FWH] || SRVH.length);
const FW2 = (NUVEM.firewalls || []).filter(f => SRVH.includes(f.fw));
const gwDe = h => { const f = FW2.find(x => (x.hosts || []).includes(h)); return f ? "S_" + f.fw : "NUVFW"; };
const ehFw = h => FW2.find(f => f.fw === h);
if (temNuvem) {
  T.nos.push({ id: "NUVFW", tipo: "firewall", host: FWH, nome: NUVEM.nome, sub: ((NUVEM.info[FWH] || {}).ip ? NUVEM.info[FWH].ip + " · " : "") + NUVEM.sub, nuvem: true, so: (NUVEM.info[FWH] || {}).so });
  // o túnel é uma ligação lógica: desenhada, mas fora da árvore (a sede não "depende" dos servidores e vice-versa)
  T.links.push({ de: T.raiz, pde: NUVEM.tunIf, para: "NUVFW", tunel: true, solto: true });
  // ordem: os firewalls extras e seus servidores no fim da lista, cada servidor logo embaixo do seu firewall
  const naWan = h => (NUVEM.wan || []).includes(h);
  const ord = SRVH.filter(h => !ehFw(h) && !naWan(h) && gwDe(h) === "NUVFW").concat(...FW2.map(f => [f.fw, ...SRVH.filter(h => gwDe(h) === "S_" + f.fw)]));
  if (S.f.srv) ord.forEach(h => { const id = "S_" + h, fw = ehFw(h);
    const inf = NUVEM.info[h] || {};
    T.nos.push({ id, tipo: fw ? "firewall" : "servidor", host: h, nome: fw ? fw.nome : h, sub: [inf.ip, inf.desc].filter(Boolean).join(" · ") || (fw ? h : "servidor · nuvem"), nuvem: true, fwExtra: !!fw, so: inf.so, img: inf.img });
    if (!fw) T.links.push({ de: gwDe(h), pde: "lan", para: id, lan: true }); });
  // na rede WAN: caixa no bloco da nuvem, sem ligação com o pfSense (não depende dele)
  if (S.f.srv) SRVH.filter(naWan).forEach(h => { const inf = NUVEM.info[h] || {};
    T.nos.push({ id: "S_" + h, tipo: "servidor", host: h, nome: h, sub: [inf.ip, inf.desc, "rede WAN"].filter(Boolean).join(" · "), nuvem: true, wanNuv: true, so: inf.so, img: inf.img }); });
}
/* --- estado dos nós --- */
const N = {}; T.nos.forEach(n => { N[n.id] = Object.assign({ filhos: [], pai: null, link: null }, n); });
T.links.forEach(l => { if (l.solto) return; const a = N[l.de], b = N[l.para]; if (!a || !b) return; a.filhos.push(b.id); b.pai = a.id; b.link = l; });
const raiz = N[T.raiz];
// túnel nuvem ↔ sede (ping do Zabbix até a RB pelo túnel): 0 = o Zabbix não enxerga a sede, então os valores da sede são velhos
const RBH = raiz && HOST[raiz.host], tunSt = RBH && RBH.tun != null ? RBH.tun : null;
const AREA = {}; Object.values(N).forEach(n => { let x = n; while (x) { const a = AREAS.find(a => a.raiz === x.id); if (a) { AREA[n.id] = a.id; break; } x = x.pai ? N[x.pai] : null; } });
const prOf = h => P.filter(p => p.h === h).sort((a, b) => b.sev - a.sev);
const SEV_COR = 2;   // problema abaixo de Warning (Informação, Não classificado) aparece no cartão, mas não pinta o equipamento
const prCor = pr => pr.filter(p => p.sev >= SEV_COR);
const okInfo = pr => pr.length ? `online · ${pr.length} aviso(s) informativo(s)` : "online";
function estado(n) {
  if (n.tipo === "wan") {
    // internet do link testada pela própria RB (Netwatch + IP sentinela): é o que decide o estado do link
    const ri = tunSt === 0 ? undefined : n.wan && n.wan.inet && raiz && HOST[raiz.host] ? HOST[raiz.host].inet[n.wan.inet] : undefined;
    if (ri === 0) { n.pr = []; return { st: "down", why: "sem internet (teste do roteador)" }; }
    if (n.wan && n.wan.ping) { const g = HOST[n.wan.ping]; n.pr = prOf(n.wan.ping);
      if (!g || g.ping == null) return { st: "unk", why: "sem dados do ping" };
      if (g.ping === 0) return { st: "down", why: "IP público sem resposta" };
      const pc = prCor(n.pr); return pc.length ? { st: pc[0].sev >= 4 ? "hi" : "warn", why: pc[0].p } : { st: "ok", why: okInfo(n.pr) }; }
    if (ri === 1 && !(n.wan && n.wan.ping)) { n.pr = []; return { st: "ok", why: "com internet (teste do roteador)" }; }
    if (n.wan && n.wan.dhcp) { const r = raiz && HOST[raiz.host]; n.pr = [];
      if (!r || r.dhcp == null) return { st: "warn", why: "sem teste de internet (só a porta)" };
      return r.dhcp === 0 ? { st: "down", why: "sem IP no DHCP client" } : { st: "ok", why: "com IP da operadora" }; }
    return { st: "unk", why: tunSt === 0 ? "sem visibilidade (túnel)" : "" };
  }
  const o = HOST[n.host]; n.pr = prOf(n.host);
  if (!o) return { st: "unk", why: "sem dados no Zabbix" };
  if (o.ping === 0 || (o.ping == null && (o.snmp === 0 || o.ag === 0))) return { st: "down", why: o.ping === 0 ? "sem resposta ao ping" : o.snmp === 0 ? "SNMP sem resposta" : "agente sem resposta" };
  const pc = prCor(n.pr); if (pc.length) return { st: pc[0].sev >= 4 ? "hi" : "warn", why: pc[0].p };
  if (o.snmp === 0 && durou(o.snmpH, v => v === 0) >= SNMP_MIN_MIN * 60000) return { st: "warn", why: "ping ok, SNMP sem resposta" };
  if (o.ag === 0 && durou(o.agH, v => v === 0) >= SNMP_MIN_MIN * 60000) return { st: "warn", why: "ping ok, agente sem resposta" };
  if (o.ping == null && o.snmp == null && o.ag == null) return { st: "unk", why: "sem dados" };
  return { st: "ok", why: okInfo(n.pr) };
}
Object.values(N).forEach(n => Object.assign(n, estado(n)));
// causa raiz: nó fora com ancestral fora = consequência (o problema está acima dele)
Object.values(N).forEach(n => { if (n.st !== "down") return; let a = n.pai ? N[n.pai] : null, top = null;
  while (a) { if (a.st === "down") top = a; a = a.pai ? N[a.pai] : null; } n.causa = top ? top.id : null; });
// túnel / pfSense: o Zabbix fica na nuvem, então túnel fora = a sede inteira some (sem visibilidade), não "a RB caiu"
const fwDown = !!(N.NUVFW && N.NUVFW.st === "down");
const visCausa = !N.NUVFW ? null : fwDown ? "NUVFW" : tunSt === 0 ? "TUN" : null;
// link de internet com ping do IP público fora = provável motivo do túnel ter caído (esse ping vai direto da nuvem, não passa pelo túnel)
const wanFora = raiz ? raiz.filhos.filter(c => N[c].tipo === "wan" && N[c].wan && N[c].wan.ping && N[c].st === "down").map(c => N[c].nome) : [];
if (visCausa === "TUN") N.TUN = { id: "TUN", tipo: "tunel", nome: "Túnel nuvem ↔ " + SITE + (wanFora.length ? ` · provável: ${wanFora.join(", ")} fora` : ""), st: "down", why: "sem resposta pelo túnel", filhos: [], pai: null, pr: [] };
// Sem túnel (ou sem pfSense) o Zabbix não alcança a sede: o que aparece lá é o último valor antes da queda (um ficaria verde, outro
// vermelho, a RB laranja pelo alerta do túnel). Nada disso é real: toda a sede fica "sem visibilidade", e a causa é o túnel/pfSense.
const semVis = !!visCausa;
const tunVoltouMs = !semVis && tunSt === 1 && RBH ? haQuanto(RBH.tunH, v => v === 0) : Infinity;
const aquecendo = tunVoltouMs < CARENCIA_MIN * 60000;   // túnel voltou agora: os pings da sede ainda estão chegando
if (aquecendo) Object.values(N).forEach(n => { if (n.nuvem || n.st !== "down" || (n.tipo === "wan" && !/teste do roteador/.test(n.why || ""))) return;
  n.st = "unk"; n.causa = null; n.why = `atualizando (túnel voltou há ${Math.round(tunVoltouMs / 1000)} s)`; });
const pingDireto = n => n.tipo === "wan" && n.wan && n.wan.ping;   // ping do IP público vai direto da nuvem: continua valendo
if (semVis) Object.values(N).forEach(n => { if (n.nuvem || n.id === "TUN" || pingDireto(n)) return;
  n.st = "unk"; n.causa = visCausa; n.why = "sem visibilidade"; });
// o túnel sai pela internet: pelo primeiro link da lista NUVEM.via que estiver no ar (sem nenhum no ar: o primeiro que existir)
const wanOk = id => N[id] && N[id].tipo === "wan" && (N[id].st === "ok" || N[id].st === "warn" || N[id].st === "hi");
const tunVia = NUVEM.via.find(wanOk) || NUVEM.via.find(id => N[id] && N[id].st === "unk") || NUVEM.via.find(id => N[id]) || T.raiz;
T.links.forEach(l => { if (l.tunel) l.de = tunVia; });
const causaTxt = n => n.causa === "TUN" ? "sem visibilidade (túnel)" : n.causa === "NUVFW" ? "sem visibilidade (pfSense)" : "afetado por " + N[n.causa].nome;
// servidores da nuvem (mesmo fechados, para o contador e o indicador)
const SRV = SRVH.map(h => { const t = { host: h }; return Object.assign(t, estado(t)); });
const desc = id => { const out = []; const go = x => N[x].filhos.forEach(c => { out.push(c); go(c); }); go(id); return out; };
// câmeras: estado pelo ping; câmera atrás de switch fora = consequência (não conta como "fora" no contador do switch)
const CAMS = (T.cams || []).filter(c => N[c.sw]).map(c => { const o = HOST[c.host];
  return Object.assign({}, c, { st: semVis || !o || o.ping == null ? "unk" : o.ping === 0 ? (aquecendo ? "unk" : "down") : "ok", pr: prOf(c.host) }); });
const camsDe = id => CAMS.filter(c => c.sw === id);
const camsAbaixo = id => { const ids = new Set([id, ...desc(id)]); return CAMS.filter(c => ids.has(c.sw) && !camNo(c.sw)); };   // as abertas já contam como caixas
const camFora = c => c.st === "down" && N[c.sw].st !== "down" && !N[c.sw].causa;

/* --- ligações --- */
const L = T.links.filter(l => N[l.de] && N[l.para]).map(l => {
  const a = N[l.de], b = N[l.para];
  if (semVis && !l.tunel && !l.lan && !pingDireto(b)) return Object.assign({}, l, { p: null, lado: "de", down: null, up: null, util: null, st: "unk", wifi: l.pde === "wifi" });
  // túnel: estado pelo ping do Zabbix até a RB pelo túnel; tráfego pela interface do túnel na RB (↓ = nuvem → sede)
  if (l.tunel) { const p = raiz ? porta(raiz.host, NUVEM.tunIf) : null;
    return Object.assign({}, l, { p, lado: "de", down: p && p.rx, up: p && p.tx, util: null, st: b.st === "down" || tunSt === 0 ? "down" : tunSt === 1 ? "ok" : "unk" }); }
  if (l.lan) return Object.assign({}, l, { p: null, lado: "de", down: null, up: null, util: null, st: b.st === "down" ? "down" : b.st === "unk" ? "unk" : "ok" });
  // ligação sem fio (pde: "wifi"): não há porta para ler; o estado é o do equipamento ligado por Wi-Fi
  if (l.pde === "wifi") return Object.assign({}, l, { wifi: true, p: null, lado: "de", down: null, up: null, util: null, st: b.st === "down" ? "down" : b.st === "unk" ? "unk" : "ok" });
  let p = porta(a.host, l.pde), lado = "de";
  if (!p && b.host && l.ppara != null) { p = porta(b.host, l.ppara); lado = "para"; }
  const down = lado === "de" ? (p && p.tx) : (p && p.rx), up = lado === "de" ? (p && p.rx) : (p && p.tx);
  const util = p && p.sp ? Math.max(down || 0, up || 0) / p.sp * 100 : null;
  let st = b.tipo === "wan" ? b.st : !p || p.st == null ? "unk" : p.st === 1 ? (util != null && util >= UTIL_CRITICO ? "hi" : util != null && util >= UTIL_ATENCAO ? "warn" : "ok") : "down";
  return Object.assign({}, l, { p, lado, down, up, util, st });
});
/* Ligação nunca fica verde se o equipamento de um dos lados não responde. A porta lida no switch pai é o ÚLTIMO valor conhecido:
   quando o pai (ou o filho) cai, ela continua "up" e o tráfego continua parado no último número. Equipamento fora, ou fora por causa
   de um ancestral, derruba a ligação (e o tráfego antigo some). "sem dados" (sem visibilidade/atualizando) continua cinza de propósito. */
L.forEach(l => { const a = N[l.de], b = N[l.para];
  if (l.tunel || l.st === "unk" || l.st === "down" || a.nuvem || b.nuvem || b.tipo === "wan") return;
  if (a.st === "down" || b.st === "down") { l.st = "down"; l.caiuPor = a.st === "down" ? a.id : b.id; l.down = null; l.up = null; l.util = null; } });
const LBY = {}; L.forEach(l => { LBY[l.para] = l; });

/* --- o que aparece (filtros): um equipamento oculto continua aparecendo se algo visível depende dele (mantém o caminho) --- */
const GRUPO = { ap: "ap", acesso: "acesso", tvip: "acesso", nvr: "nvr", nas: "nvr", camera: "cam" };
const temProblema = n => n.st !== "ok" || !!n.causa || camsDe(n.id).some(c => c.st === "down");
function baseVis(n) {
  if (n.tipo === "wan" || n.id === T.raiz) return true;
  if (S.f.area !== "tudo" && !n.nuvem && (AREA[n.id] || "sede") !== S.f.area) return false;   // filtro de área (o caminho até a RB continua aparecendo)
  const g = GRUPO[n.tipo]; if (g !== "cam" && g && !S.f[g]) return false;
  return !S.f.soProb || temProblema(n);
}
const VIS = {};
const vis = id => { if (id in VIS) return VIS[id]; VIS[id] = false; return (VIS[id] = baseVis(N[id]) || N[id].filhos.some(vis)); };
Object.keys(N).forEach(vis);
const ocultos = Object.keys(N).filter(id => !VIS[id]).length;

/* --- layout em árvore (esquerda -> direita) --- */
const W = 196, H = 50, COL = 268, ROW = 74, PADX = 14, PADY = 16;
const pos = {}; let fila = 0;
function place(id, d) {
  const n = N[id], kids = n.filhos.filter(c => N[c].tipo !== "wan" && VIS[c]);
  if (!kids.length) { pos[id] = { x: PADX + (d + 1) * COL, y: PADY + fila * ROW }; fila++; return pos[id].y; }
  const ys = kids.map(c => place(c, d + 1));
  pos[id] = { x: PADX + (d + 1) * COL, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  return pos[id].y;
}
if (raiz) place(raiz.id, 0);
const wans = raiz ? raiz.filhos.filter(c => N[c].tipo === "wan") : [];
wans.forEach((id, i) => { pos[id] = { x: PADX, y: pos[raiz.id].y + (i - (wans.length - 1) / 2) * (ROW + 14) }; });
// nuvem: pfSense numa coluna à esquerda dos links (o túnel liga no link ativo); servidores abertos mais à esquerda, centrados no pfSense
if (N.NUVFW && VIS.NUVFW && raiz && pos[raiz.id]) {
  const ys = wans.map(w => pos[w].y), wy = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : pos[raiz.id].y;
  pos.NUVFW = { x: PADX - COL, y: wy };                       // à esquerda dos links: nuvem ← túnel ← link ← RB
  const sv = N.NUVFW.filhos.filter(c => VIS[c]);
  sv.forEach((id, i) => { pos[id] = { x: PADX - 2 * COL, y: pos.NUVFW.y + (i - (sv.length - 1) / 2) * ROW }; });   // centrados no pfSense
  sv.forEach(id => { const k = N[id].filhos.filter(c => VIS[c]);                // servidores atrás de outro firewall: uma coluna mais à esquerda
    k.forEach((c, i) => { pos[c] = { x: PADX - 3 * COL, y: pos[id].y + (i - (k.length - 1) / 2) * ROW }; }); });
  let yb = Math.max(pos.NUVFW.y, ...sv.map(id => pos[id].y)) + ROW + 14;   // outros firewalls e rede WAN: embaixo, separados
  Object.keys(N).filter(id => N[id].fwExtra && VIS[id]).forEach(id => { pos[id] = { x: PADX - COL, y: yb };
    N[id].filhos.filter(c => VIS[c]).forEach((c, i) => { pos[c] = { x: PADX - 2 * COL, y: yb + i * ROW }; });
    yb += Math.max(1, N[id].filhos.filter(c => VIS[c]).length) * ROW + 14; });
  Object.keys(N).filter(id => N[id].wanNuv && VIS[id]).forEach(id => { pos[id] = { x: PADX - 2 * COL, y: yb }; yb += ROW; });
}
/* --- layout em COLUNAS (padrão): internet em cima, RB e o tronco descendo, e um ramo por coluna em lista com recuo ---
 * Cabe muito melhor numa tela 16:9 que a árvore deitada (que fica alta e estreita). Botão "Layout" alterna com a árvore. */
const MODO = S.f.lay === "arvore" ? "arvore" : "col";
const EDGE = {};                                   // traçado por ligação (chave = filho): "topo" (de cima para baixo) | "pente" (lista com recuo)
const IND = 30, RH = H + 12, PILL = 20, LBL = 96, CW = W + LBL + 40, GAPV = 50;
if (MODO === "col" && raiz) {
  Object.keys(pos).forEach(k => delete pos[k]);
  const kidsV = id => N[id].filhos.filter(c => VIS[c] && N[c].tipo !== "wan");
  const tronco = [raiz.id]; let t = raiz.id;         // RB e, enquanto houver um filho só, desce em linha reta (RB → SW-CORE)
  while (kidsV(t).length === 1 && kidsV(kidsV(t)[0]).length) { t = kidsV(t)[0]; tronco.push(t); }
  const heads = kidsV(t);
  const temPill = id => !!((S.f.cam === "cont" && camsDe(id).length) || (id === "NUVFW" && SRV.length));
  const temCloud = !!(N.NUVFW && VIS.NUVFW);
  const X0 = PADX + (temCloud ? CW : 0), ncol = Math.max(heads.length, 1);
  const meio = X0 + (ncol * CW - LBL - 40) / 2 - W / 2;
  const yW = PADY + 54;                             // espaço acima: rótulo da área e a curva do túnel
  const ws = wans.slice().sort((a, b) => (NUVEM.via.indexOf(a) + 99) % 99 - (NUVEM.via.indexOf(b) + 99) % 99);   // link principal à esquerda (perto da nuvem)
  ws.forEach((id, i) => { pos[id] = { x: meio + (i - (ws.length - 1) / 2) * (W + 70), y: yW }; EDGE[id] = "topo"; });
  let y = yW + (ws.length ? H + GAPV : 0);
  tronco.forEach((id, i) => { pos[id] = { x: meio, y }; if (i) EDGE[id] = "topo"; y += H + (temPill(id) ? PILL : 0) + GAPV; });
  heads.forEach((h, i) => { let row = y; const x0 = X0 + i * CW;
    const go = (id, d) => { const ar = AREAS.some(a => a.raiz === id); if (ar) row += 22;
      pos[id] = { x: x0 + d * IND, y: row }; EDGE[id] = d ? "pente" : "topo"; row += RH + (temPill(id) ? PILL : 0); kidsV(id).forEach(c => go(c, d + 1)); if (ar) row += 10; };
    go(h, 0); });
  if (temCloud) { pos.NUVFW = { x: PADX, y: yW }; let row = yW + RH + PILL;      // pfSense na linha dos links; servidores em lista embaixo
    const lista = (id, d) => N[id].filhos.filter(c => VIS[c]).forEach(c => { pos[c] = { x: PADX + d * IND, y: row }; EDGE[c] = "pente"; row += RH; lista(c, d + 1); });
    lista("NUVFW", 1); row += 16;
    Object.keys(N).filter(id => N[id].fwExtra && VIS[id]).forEach(id => { pos[id] = { x: PADX, y: row }; row += RH; lista(id, 1); row += 16; });
    Object.keys(N).filter(id => N[id].wanNuv && VIS[id]).forEach(id => { pos[id] = { x: PADX + IND, y: row }; row += RH; }); }
}
const avulsos = Object.values(N).filter(n => !pos[n.id] && VIS[n.id] && n.id !== "TUN");
const minY = Math.min(...Object.values(pos).map(p => p.y), PADY), minX = Math.min(...Object.values(pos).map(p => p.x), PADX);
Object.values(pos).forEach(p => { p.y += PADY - minY; p.x += PADX - minX; });
const VW = Math.max(...Object.values(pos).map(p => p.x)) + W + PADX, VH = Math.max(...Object.values(pos).map(p => p.y)) + H + PADY;

/* --- desenho --- */
const COLR = { ok: "#22c55e", warn: "#f5b301", hi: "#fb923c", down: "#ef4444", unk: "#64748b" };
// ícones desenhados (grade 24x24, só traço): reconhecíveis pela forma, a cor segue o estado quando há problema
const ICO = {
  wan: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 7.5h14M5 16.5h14"/>',
  router: '<rect x="2" y="11" width="20" height="8" rx="2"/><path d="M7 11L5 4M17 11l2-7"/><circle cx="6.5" cy="15" r="1" fill="currentColor"/><circle cx="10" cy="15" r="1" fill="currentColor"/><path d="M14 15h5"/>',
  switch: '<rect x="1" y="7" width="22" height="10" rx="2"/><path d="M4.5 10.5h2.5v3h-2.5zM8.5 10.5h2.5v3h-2.5zM12.5 10.5h2.5v3h-2.5zM16.5 10.5h2.5v3h-2.5z"/>',
  ap: '<ellipse cx="12" cy="18" rx="9" ry="3.5"/><path d="M8.5 10.5a5 5 0 0 1 7 0M5.5 7.5a9.5 9.5 0 0 1 13 0"/><circle cx="12" cy="13.5" r="1.2" fill="currentColor"/>',
  nvr: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M5 10h9M5 14h9"/><circle cx="18" cy="12" r="1.5" fill="currentColor"/>',
  nas: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M7 7h10M7 11h10M7 15h10"/><circle cx="16" cy="18.5" r="1" fill="currentColor"/>',
  camera: '<rect x="2" y="7" width="13" height="8" rx="1.5"/><path d="M15 10l6-3v8l-6-3"/><path d="M6 15v4H3"/>',
  tvip: '<rect x="2" y="3" width="20" height="13" rx="2"/><path d="M8 20h8M12 16v4"/><circle cx="12" cy="9.5" r="2.5"/>',
  acesso: '<rect x="5" y="1.5" width="14" height="21" rx="2.5"/><circle cx="12" cy="8.5" r="3"/><path d="M7.5 16a4.5 4.5 0 0 1 9 0"/><path d="M9.5 19.5h5"/>',
  firewall: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 9.3h20M2 14.6h20M8 4v5.3M16 4v5.3M12 9.3v5.3M6 14.6V20M18 14.6V20"/>',
  servidor: '<rect x="3" y="3" width="18" height="7" rx="1.5"/><rect x="3" y="14" width="18" height="7" rx="1.5"/><circle cx="7" cy="6.5" r="1" fill="currentColor"/><circle cx="7" cy="17.5" r="1" fill="currentColor"/><path d="M11 6.5h6M11 17.5h6"/>',
};
const NOME_TIPO = { wan: "link de internet", router: "roteador", switch: "switch", ap: "access point", nvr: "gravador (NVR)", acesso: "controle de acesso", tvip: "interfone IP", interfone: "interfone IP", outro: "equipamento", camera: "câmera", nas: "NAS", firewall: "firewall da nuvem", servidor: "servidor da nuvem" };
const icone = (tipo, cor, x, y, s) => `<g class="mp-ico" transform="translate(${x},${y}) scale(${s / 24})" style="color:${cor}" fill="none" stroke="currentColor" stroke-width="${(1.6 * 24 / s).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round">${ICO[tipo] || '<circle cx="12" cy="12" r="8"/>'}</g>`;
const curva = (a, b) => { const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, m = (x1 + x2) / 2; return `M${x1},${y1} C${m},${y1} ${m},${y2} ${x2},${y2}`; };
const curvaWan = (w, r) => { const x1 = w.x + W, y1 = w.y + H / 2, x2 = r.x, y2 = r.y + H / 2, m = (x1 + x2) / 2; return `M${x1},${y1} C${m},${y1} ${m},${y2} ${x2},${y2}`; };
const cut = (t, k) => !t || t.length <= k ? t : t.slice(0, k - 1) + "…";
const portLbl = l => l.tunel ? `túnel · via ${N[l.de] ? N[l.de].nome : "?"}` : l.lan ? "LAN da nuvem" : l.pde === "wifi" ? "Wi-Fi" : typeof l.pde === "number" ? `p${l.pde}${l.ppara != null ? " ⇄ p" + l.ppara : ""}` : l.pde;
const pillH = id => (S.f.cam === "cont" && camsDe(id).length) || (id === "NUVFW" && SRV.length) ? PILL : 0;
function tracado(l, a, b) {   // devolve [caminho, x e y do rótulo (2 linhas), âncora]
  const e = EDGE[l.para];
  if (MODO === "col" && l.tunel) {   // nuvem → link ativo: curva por cima da linha dos links
    const x1 = b.x + W, y1 = b.y + H / 2, x2 = a.x + W / 2, y2 = a.y;
    return [`M${x1},${y1} C${x1 + 70},${y1 - 60} ${x2},${y2 - 60} ${x2},${y2}`, x1 + 10, y1 - 22, "start"]; }
  if (MODO === "col" && e === "pente") {   // lista com recuo: desce pela esquerda do pai e entra pela esquerda do filho
    const sx = a.x + 16, cy = b.y + H / 2, y0 = a.y + H + pillH(l.de);
    return [`M${sx},${y0} V${cy - 7} Q${sx},${cy} ${sx + 7},${cy} H${b.x}`, b.x + W + 6, b.y + H / 2 - 2, "start"]; }
  if (MODO === "col" && e === "topo") {   // de cima para baixo (links → RB → tronco → cabeça de cada coluna)
    const up = a.y < b.y ? a : b, dn = up === a ? b : a, upId = up === a ? l.de : l.para;
    const x1 = up.x + W / 2, y1 = up.y + H + pillH(upId), x2 = dn.x + W / 2, y2 = dn.y, m = (y1 + y2) / 2;
    const wan = N[l.para].tipo === "wan";
    return [`M${x1},${y1} C${x1},${m} ${x2},${m} ${x2},${y2}`, wan ? x1 + 6 : x2 + 6, wan ? y1 + 12 : y2 - 18, "start"]; }
  const esq = N[l.para].tipo === "wan" || l.tunel || l.lan;      // árvore deitada (modo antigo): filho à esquerda do pai
  return [esq ? curvaWan(b, a) : curva(a, b), esq ? b.x + W + 8 : b.x - 8, b.y + H / 2, esq ? "start" : "end"];
}
const ESP = {};   // espinha de cada pai no modo colunas: do pé do pai até o último filho
if (MODO === "col") L.forEach(l => { if (EDGE[l.para] !== "pente" || !pos[l.de] || !pos[l.para]) return;
  const a = pos[l.de], e = ESP[l.de] = ESP[l.de] || { x: a.x + 16, y1: a.y + H + pillH(l.de), y2: 0 };
  e.y2 = Math.max(e.y2, pos[l.para].y + H / 2 - 7); });
const espinhas = Object.values(ESP).map(e => `<path class="mp-esp" d="M${e.x},${e.y1} V${e.y2}"/>`).join("");
// em lista, cada ligação desce pela espinha até o seu filho: desenha do mais distante para o mais perto, assim o trecho
// logo acima de cada equipamento fica na cor da ligação dele (verde, amarelo, vermelho...)
const ordK = l => EDGE[l.para] === "pente" && pos[l.para] ? -pos[l.para].y : -1e9;   // as outras ligações primeiro
const ordemL = L.slice().sort((x, y) => ordK(x) - ordK(y));
const FX = S.f.fluxo !== false;   // animação de fluxo nas ligações (botão "Fluxo animado")
// o mapa é redesenhado a cada atualização: a fase da animação vem do relógio, senão os pontos voltariam ao início a cada refresh
const atraso = ms => `style="animation-delay:-${((Date.now() % ms) / 1000).toFixed(2)}s"`;
const edgesSvg = espinhas + ordemL.map(l => {
  const a = pos[l.de], b = pos[l.para]; if (!a || !b) return "";
  const [d, mx, my, anc] = tracado(l, a, b);
  const w = l.util == null ? 1.8 : 1.8 + Math.min(l.util, 100) / 100 * 3.5;
  const tr = l.p && (l.down != null || l.up != null) ? `↓${kb(l.down)} ↑${kb(l.up)}` : "";
  if (l.lan) return `<g class="mp-e ${l.st}${FX ? " fx" : ""}" data-e="${esc(l.para)}"><path class="mp-hit" d="${d}"/><path class="mp-ln ${l.st === "unk" ? "dash" : ""}" d="${d}" stroke="${COLR[l.st]}" stroke-width="1.4"${l.st === "down" ? " " + atraso(1000) : ""}/>${FX && (l.st === "ok" || l.st === "warn" || l.st === "hi") ? `<path class="mp-fl" d="${d}" stroke-width="2.6" ${atraso(1100)}/>` : ""}</g>`;   // sem rótulo: seriam 11 "LAN da nuvem"
  const cor = l.wifi ? (l.st === "ok" ? "#22d3ee" : COLR[l.st]) : l.tunel ? (l.st === "ok" ? "#a78bfa" : COLR[l.st]) : COLR[l.st];
  const viva = FX && (l.st === "ok" || l.st === "warn" || l.st === "hi");   // "sem dados" não anima: movimento sugere tráfego que não está sendo medido
  const per = l.st === "down" ? 1000 : l.tunel ? 1100 : l.wifi ? 800 : 0;
  return `<g class="mp-e ${l.st}${FX ? " fx" : ""}" data-e="${esc(l.para)}"><path class="mp-hit" d="${d}"/><path class="mp-ln ${l.st === "unk" ? "dash" : ""} ${l.trunk ? "trunk" : ""} ${l.wifi ? "wifi" : ""} ${l.tunel ? "tunel" : ""}" d="${d}" stroke="${cor}" stroke-width="${(l.tunel ? 2.6 : w).toFixed(1)}"${per ? " " + atraso(per) : ""}/>${viva && !l.tunel && !l.wifi ? `<path class="mp-fl" d="${d}" stroke-width="${Math.max(2.6, w + 0.8).toFixed(1)}" ${atraso(1100)}/>` : ""}
    <text class="mp-el" x="${mx}" y="${my - 5}" text-anchor="${anc}">${esc(portLbl(l))}</text>${tr ? `<text class="mp-et" x="${mx}" y="${my + 9}" text-anchor="${anc}">${esc(tr)}</text>` : ""}</g>`;
}).join("");
function camPill(n) {
  const cs = camsDe(n.id); if (!cs.length || S.f.cam !== "cont") return "";
  const f = cs.filter(camFora).length, u = cs.filter(c => c.st === "unk").length, semSw = n.st === "down" || n.causa;
  const aberto = !!S.camAbre[n.id];
  const t = `${aberto ? "▾" : "▸"} câmeras ${cs.length}` + (semVis ? " · sem visibilidade" : semSw ? " · sem acesso" : f ? ` · ${f} fora` : u === cs.length ? " · sem dados" : u ? ` · ${u} sem dados` : "");
  const cls = (semVis ? "unk" : semSw || f ? "down" : u ? "unk" : "ok") + (aberto ? " aberto" : "");
  return `<g class="mp-cam ${cls}" data-cam="${n.id}"><title>${aberto ? "Clique para fechar as câmeras deste switch" : "Clique para ver só as câmeras deste switch"}</title><rect x="7" y="${H + 3}" width="${(16 + t.length * 6.9).toFixed(0)}" height="17" rx="8.5"/><text x="14" y="${H + 15.6}">${esc(t)}</text></g>`;
}
// contador de servidores embaixo do pfSense: clique abre/fecha as caixas dos servidores
function srvPill(n) {
  if (n.id !== "NUVFW" || !SRV.length) return "";
  const f = SRV.filter(s => s.st === "down").length, al = SRV.filter(s => s.st === "warn" || s.st === "hi").length, u = SRV.filter(s => s.st === "unk").length;
  const ab = !!S.f.srv;
  const t = `${ab ? "▾" : "▸"} servidores ${SRV.length}` + (f ? ` · ${f} fora` : al ? ` · ${al} em alerta` : u === SRV.length ? " · sem dados" : u ? ` · ${u} sem dados` : "");
  const cls = (f ? "down" : al ? "warn" : u ? "unk" : "ok") + (ab ? " aberto" : "");
  return `<g class="mp-cam ${cls}" data-srv="1"><title>${ab ? "Clique para fechar os servidores" : "Clique para ver os servidores da nuvem"}</title><rect x="7" y="${H + 3}" width="${(16 + t.length * 6.9).toFixed(0)}" height="17" rx="8.5"/><text x="14" y="${H + 15.6}">${esc(t)}</text></g>`;
}
// área da nuvem: moldura em volta do pfSense e dos servidores
const moldura = (ids, nome, cls) => { ids = ids.filter(id => pos[id]); if (!ids.length) return "";
  const ps = ids.map(id => pos[id]), x0 = Math.min(...ps.map(p => p.x)) - 12, y0 = Math.min(...ps.map(p => p.y)) - (MODO === "col" && cls === "area" ? 22 : 28), x1 = Math.max(...ps.map(p => p.x)) + W + 12, y1 = Math.max(...ps.map(p => p.y)) + H + 28;
  return `<g class="mp-zona ${cls}"><rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="12"/><text x="${x0 + 12}" y="${y0 + 17}">${esc(nome)}</text></g>`; };
const zonaNuvem = moldura(Object.keys(N).filter(id => N[id].nuvem), (NUVEM.sub || "nuvem").toUpperCase(), "nuvem")
  + AREAS.map(a => moldura(Object.keys(N).filter(id => AREA[id] === a.id), a.nome, "area")).join("");
// largura estimada do nome (12px): só comprime o que não cabe; nome curto não é esticado
const larg = t => [...(t || "")].reduce((a, ch) => a + (/[A-Z0-9_]/.test(ch) ? 7.7 : /[ ·.\-]/.test(ch) ? 3.6 : 6.3), 0);
const nodesSvg = Object.values(N).filter(n => pos[n.id]).map(n => {
  const p = pos[n.id], c = COLR[n.st], conseq = n.causa ? " conseq" : "";
  return `<g class="mp-n ${n.st}${conseq} t-${n.tipo}" data-n="${n.id}" transform="translate(${p.x},${p.y})">
    <rect width="${W}" height="${H}" rx="10" class="mp-box" style="--c:${c}"/>
    <circle cx="25" cy="${H / 2}" r="18" class="mp-ring ${n.st === "down" ? "blink" : ""}" stroke="${c}" filter="url(#mpGlow)"/>${imgDe(n) ? `<image href="${esc(imgDe(n))}" x="12" y="${H / 2 - 13}" width="26" height="26" preserveAspectRatio="xMidYMid meet" clip-path="circle(13px at 13px 13px)"/>` : icone(n.tipo, n.st === "ok" ? "#e2e8f0" : c, 13, H / 2 - 12, 24)}${n.so && SO[n.so] && !imgDe(n) ? (() => { const [t, cor] = SO[n.so], w = 7 + t.length * 5.1;   // etiqueta do sistema: selo embaixo do ícone
      return `<g class="mp-so"><rect x="${25 - w / 2}" y="${H - 12}" width="${w}" height="11" rx="5.5" fill="#0a1322" stroke="${cor}"/><text x="25" y="${H - 3.6}" fill="${cor}" text-anchor="middle">${t}</text></g>`; })() : ""}
    <circle cx="${W - 11}" cy="11" r="3.5" fill="${c}"/>
    <text x="50" y="19" class="mp-t"${larg(cut(n.nome, 22)) > 124 ? ' textLength="124" lengthAdjust="spacingAndGlyphs"' : ""}>${esc(cut(n.nome, 22))}</text>
    <text x="50" y="33" class="mp-s">${esc(cut(n.sub || (n.host !== n.nome ? n.host : "") || "", 24))}</text>
    <text x="50" y="45" class="mp-w ${n.st}">${esc(cut(n.causa ? causaTxt(n) : n.st === "ok" ? "" : n.why, 28))}</text>${camPill(n)}${srvPill(n)}</g>`;
}).join("");

/* --- resumo, lista de atenção, legenda --- */
const cnt = t => { const a = Object.values(N).filter(n => n.tipo === t); return { n: a.length, ok: a.filter(n => n.st === "ok" || n.st === "warn" || n.st === "hi").length }; };
const cs = cnt("switch"), ca = cnt("ap"), cw = cnt("wan");
const raizes = Object.values(N).filter(n => n.st === "down" && !n.causa && n.tipo !== "wan" && n.tipo !== "camera");   // câmera fora já aparece no indicador Câmeras   // link fora já aparece em Internet
// quantos ficam para trás: túnel/pfSense fora = a sede inteira sem visibilidade
const atras = n => n.id === "TUN" || n.id === "NUVFW" ? Object.values(N).filter(x => x.causa === n.id).length + (raiz ? camsAbaixo(raiz.id).length : 0) + (n.id === "NUVFW" ? desc(n.id).length : 0)
                                                     : desc(n.id).length + camsAbaixo(n.id).length;
const camOff = CAMS.filter(camFora), camOk = CAMS.filter(c => c.st === "ok").length, camAtras = CAMS.filter(c => c.st === "down" && !camFora(c)).length;
const kpi = (l, v, s, cls) => `<div class="kpi ${cls}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
const sOk = SRV.filter(s => s.st !== "down" && s.st !== "unk").length;
const kNuvem = temNuvem ? kpi("Nuvem", `${sOk}<span> / ${SRV.length}</span>`,
  fwDown ? "pfSense FORA" : tunSt === 0 ? "servidores · TÚNEL FORA" : `servidores · túnel ${tunSt === 1 ? "ok via " + (N[tunVia] ? N[tunVia].nome : "?") : "sem dados"}`,
  fwDown || tunSt === 0 ? "crit" : sOk < SRV.length ? (SRV.length - sOk > 1 ? "crit" : "warn") : tunSt == null ? "warn" : "ok") : "";
const kpis = `<section class="kpis mp-kpis${(CAMS.length ? 1 : 0) + (temNuvem ? 1 : 0) === 2 ? " mp-k6" : CAMS.length || temNuvem ? " mp-k5" : ""}">
  ${kpi("Internet", `${cw.ok}<span> / ${cw.n}</span>`, semVis && Object.values(N).some(n => n.tipo === "wan" && n.st === "unk") ? `${Object.values(N).filter(n => n.tipo === "wan" && n.st === "unk").map(n => n.nome).join(", ")} sem visibilidade` : cw.ok === cw.n ? "links ok" : cw.ok ? "em contingência" : "SEM INTERNET", cw.ok === cw.n ? "ok" : cw.ok ? "warn" : "crit")}
  ${kpi("Switches", `${cs.ok}<span> / ${cs.n}</span>`, semVis ? "sem visibilidade" : "respondendo", cs.ok === cs.n ? "ok" : "crit")}
  ${kpi("Access points", `${ca.ok}<span> / ${ca.n}</span>`, semVis ? "sem visibilidade" : "respondendo", ca.ok === ca.n ? "ok" : ca.ok >= ca.n - 1 ? "warn" : "crit")}
  ${CAMS.length ? kpi("Câmeras", `${camOk}<span> / ${CAMS.length}</span>`, camOff.length ? `${camOff.length} fora: ${esc(camOff.slice(0, 3).map(c => c.rotulo || c.host).join(" "))}${camOff.length > 3 ? "…" : ""}` : semVis ? "sem visibilidade" : camAtras ? `${camAtras} atrás de equipamento fora` : camOk === CAMS.length ? "respondendo" : `${CAMS.length - camOk} sem dados`, camOff.length ? (camOff.length > 2 ? "crit" : "warn") : camAtras ? "crit" : camOk === CAMS.length ? "ok" : "warn") : ""}
  ${kNuvem}
  ${kpi("Causa provável", raizes.length ? esc(raizes.map(n => n.nome).join(", ")) : "—", raizes.length ? `${raizes.reduce((a, n) => a + atras(n), 0)} equipamento(s) ${raizes.some(n => n.id === "TUN" || n.id === "NUVFW") ? "sem visibilidade" : "atrás"}` : "nenhum equipamento fora", raizes.length ? "crit" : "ok")}
</section>`;
// Atenção: o mesmo problema em vários equipamentos vira UMA linha ("High ICMP ping response time · 9 equipamentos").
// Agrupa pelo nome sem o prefixo do template ("Generic SNMP:", "Linux:", "Mikrotik:"...) e sem o nome do host na frente.
const PREF_TPL = /^(Generic SNMP|Linux|Windows|Mikrotik|MikroTik|FreeBSD|pfSense|PFSense|Zabbix agent|ICMP|Cisco|Intelbras)\s*:\s*/i;
const chaveP = p => { let t = p.p.replace(PREF_TPL, ""); if (t.startsWith(p.h + ":")) t = t.slice(p.h.length + 1).trim(); else if (t.startsWith(p.h + " ")) t = t.slice(p.h.length + 1); return t; };
const GRP = {}; P.forEach(p => { const k = chaveP(p); (GRP[k] = GRP[k] || []).push(p); });
const PQ = Object.entries(GRP).map(([k, ps]) => ps.length === 1 ? ps[0] : { grupo: true, p: k, ps, h: ps.map(x => x.h), sev: Math.max(...ps.map(x => x.sev)), ts: Math.min(...ps.map(x => x.ts || Infinity)) })
  .sort((a, b) => b.sev - a.sev || (b.grupo ? b.ps.length : 1) - (a.grupo ? a.ps.length : 1) || b.ts - a.ts);
const liP = p => p.grupo
  ? `<li class="mp-grp" title="${esc(p.ps.map(x => x.h).join("\n"))}"><span class="bar" style="background:${SEVC[p.sev] || SEVC[0]}"></span><div><div class="h">${esc(p.p)} <b class="mp-n2">${p.ps.length} equipamentos</b></div><div class="p"><span class="sev" style="color:${SEVC[p.sev] || SEVC[0]}">${SEV[p.sev] || ""}</span>${esc(p.h.slice(0, 6).join(", "))}${p.h.length > 6 ? ` e mais ${p.h.length - 6}` : ""}</div></div><span class="t">${age(p.ts)}</span></li>`
  : `<li><span class="bar" style="background:${SEVC[p.sev] || SEVC[0]}"></span><div><div class="h">${esc(p.h)}</div><div class="p"><span class="sev" style="color:${SEVC[p.sev] || SEVC[0]}">${SEV[p.sev] || ""}</span>${esc(p.p)}</div></div><span class="t">${age(p.ts)}</span></li>`;
const atencao = `<div class="box"><h2>Atenção <span class="c ${P.length ? "" : "z"}" title="${P.length} problema(s) em ${PQ.length} linha(s)">${P.length}</span></h2><ul class="q">${PQ.length
  ? PQ.map(liP).join("")
  : `<li class="empty">Nenhum problema ativo.</li>`}</ul></div>`;
const leg = `<details class="box mp-leg"${S.legAberta ? " open" : ""}><summary>Legenda <em>clique para abrir</em></summary><div class="mp-lg">
  <span><i style="background:#22c55e"></i>ok</span><span><i style="background:#f5b301"></i>alerta</span><span><i style="background:#fb923c"></i>alerta High</span><span><i style="background:#ef4444"></i>fora</span><span><i style="background:#64748b"></i>sem dados</span>
  <div class="mp-tipos">${["router", "switch", "ap", "acesso", "tvip", "nvr", "nas", "camera", "wan", "firewall", "servidor"].map(t => `<span><svg viewBox="0 0 24 24" width="18" height="18">${icone(t, "#cbd5e1", 0, 0, 24)}</svg>${NOME_TIPO[t]}</span>`).join("")}</div>
  <div>"câmeras N · X fora" embaixo do switch = câmeras ligadas nele (passe o mouse no switch para ver quais e em que porta).</div>
  <div>Linha: cor = estado da porta, e vermelha também quando o equipamento de um dos lados não responde (a porta guarda o último valor) · espessura = uso · tracejada = sem dado da porta · grossa = trunk entre switches · pontilhada ciano = Wi-Fi (vermelha se o equipamento cair) · tracejada roxa = túnel com a nuvem, saindo pelo link ativo (ALFA; sem ALFA, BETA).</div>
  <div>Moldura tracejada = área (nuvem, galpão). O botão "Área" mostra só ${esc(SITE)} ou só uma área, com o caminho até o roteador.</div>
  <div>"servidores N" embaixo do pfSense = servidores da nuvem; clique para abrir. Túnel ou pfSense fora = ${esc(SITE)} fica sem visibilidade (o Zabbix está na nuvem): não quer dizer que os equipamentos caíram.</div>
  <div>Clique num equipamento para ver o caminho até a internet e o que depende dele.</div></div></details>`;
const semPos = avulsos.length ? `<div class="mp-avulsos"><b>Sem posição no mapa:</b> ${avulsos.map(n => `<span class="mp-chip ${n.st}" data-n="${n.id}"><i style="background:${COLR[n.st]}"></i>${esc(n.nome)}${n.sub ? " · " + esc(n.sub) : ""}</span>`).join("")}</div>` : "";
const fmtH = t => new Date(t).toLocaleTimeString("pt-BR");
function barraF() {
  const b = (k, txt, on, tt) => `<button data-f="${k}" class="${on ? "on" : ""}" title="${tt}">${txt}</button>`;
  const camTxt = { cont: "Câmeras: contador", det: "Câmeras: uma a uma", off: "Câmeras: ocultas" }[S.f.cam];
  return `<div class="mp-filtros"><span>Mostrar</span>${b("ap", "APs", S.f.ap, "access points")}${b("acesso", "Acesso / interfone", S.f.acesso, "controles de acesso e TVIPs")}${b("nvr", "NVR / NAS", S.f.nvr, "gravador e NAS")}${b("cam", camTxt, S.f.cam !== "off", "clique para alternar: contador no switch, uma caixa por câmera, ocultas")}
    <i></i>${AREAS.length ? b("area", "Área: " + (S.f.area === "tudo" ? "tudo" : S.f.area === "sede" ? SITE : (AREAS.find(a => a.id === S.f.area) || {}).curto), S.f.area !== "tudo", "clique para alternar: tudo, só " + SITE + ", só cada área") : ""}${b("soProb", "Só com problema", S.f.soProb, "só o que está fora ou em alerta, com o caminho até a internet")}${b("rot", "Portas e tráfego", S.f.rot, "rótulos das ligações")}${b("fluxo", "Fluxo animado", S.f.fluxo !== false, "animação nas ligações (a ligação fora já pisca sozinha). Desligue se a tela ficar pesada")}${b("lay", MODO === "col" ? "Layout: colunas" : "Layout: árvore", true, "clique para alternar: colunas (internet em cima, um ramo por coluna) ou árvore deitada")}
    ${ocultos ? `<em>${ocultos} oculto(s)</em>` : ""}${S.f.soProb && !Object.values(N).some(n => n.tipo !== "wan" && temProblema(n)) ? `<em class="ok">nenhum problema</em>` : ""}</div>`;
}

if (!Object.keys(HOST).length) {
  root.innerHTML = `<div class="dbg">Mapa: nenhum dado do Zabbix.\nConfira o datasource e os nomes dos hosts em TOPO (campo host = nome visível no Zabbix).\n\n${esc(debug.slice(0, 60).join("\n") || "Nenhum dado recebido.")}</div>`;
  return;
}
root.innerHTML = `  ${kpis}
  <div class="main mp-main${S.f.side ? "" : " sem-side"}"><div class="mp-col"><div class="mp-wrap">${barraF()}<div class="mp-path"></div><div class="mp-zoom"><button data-z="in" title="Aproximar">+</button><button data-z="out" title="Afastar">−</button><button data-z="fit" title="Ver o mapa inteiro">⤢</button><button data-z="side" title="${S.f.side ? "Esconder" : "Mostrar"} a coluna Atenção / Legenda">${S.f.side ? "⇥" : "⇤"}</button><span class="mp-zl"></span></div><svg class="mp-svg${S.f.rot ? "" : " sem-rot"}" viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="xMinYMin meet"><defs><filter id="mpGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>${zonaNuvem}${edgesSvg}${nodesSvg}</svg></div>${semPos}</div>
  <aside class="side">${atencao}${leg}</aside></div>`;

/* --- interação: caminho, impacto e detalhe no hover --- */
const svg = root.querySelector(".mp-svg"), pathEl = root.querySelector(".mp-path");
const caminho = id => { const out = []; let n = N[id]; while (n) { out.push(n.id); n = n.pai ? N[n.pai] : null; } return out; };
function selecionar(id) {
  S.sel = id;
  root.querySelectorAll(".mp-n,.mp-e").forEach(e => e.classList.remove("on", "dim"));
  if (!id || !N[id]) { pathEl.innerHTML = ""; pathEl.classList.remove("on"); return; }
  pathEl.classList.add("on");
  const cam = caminho(id), dep = desc(id), set = new Set([...cam, ...dep, ...wans]);
  root.querySelectorAll(".mp-n").forEach(e => e.classList.add(set.has(e.dataset.n) ? "on" : "dim"));
  root.querySelectorAll(".mp-e").forEach(e => { const l = LBY[e.dataset.e]; e.classList.add(l && set.has(l.para) && set.has(l.de) ? "on" : "dim"); });
  // leitura da esquerda para a direita: internet -> RB -> ... -> equipamento clicado; em cada passo, a porta por onde ele chega
  const ida = cam.slice().reverse();
  const hops = ida.map(x => { const n = N[x], l = LBY[x]; return `<span class="mp-hop ${n.st}"><b>${esc(n.nome)}</b>${l && N[l.de].tipo !== "wan" && n.tipo !== "wan" ? `<em>chega por ${esc(portLbl(l))}</em>` : ""}</span>`; }).join(`<span class="mp-arr">→</span>`);
  const quebra = ida.slice(0, -1).map(x => N[x]).find(n => n.st === "down") || cam.map(x => LBY[x]).filter(Boolean).find(l => l.st === "down");
  const tipos = dep.reduce((a, x) => { const t = N[x].tipo; a[t] = (a[t] || 0) + 1; return a; }, {});
  const ncam = camsAbaixo(id).length; if (ncam) tipos.camera = ncam;
  const TN = { switch: "switch(es)", ap: "AP(s)", nvr: "NVR", router: "roteador", acesso: "controle(s) de acesso", tvip: "TVIP(s)", camera: "câmera(s)", nas: "NAS", servidor: "servidor(es)" };
  const links = wans.map(w => `${esc(N[w].nome)} ${N[w].st === "down" ? "fora" : N[w].st === "ok" ? "ok" : "com alerta"}`).join(" · ");
  const inet = N[id].tipo === "wan" || N[id].nuvem ? "" : `<span class="mp-hop ${cw.ok ? (cw.ok < cw.n ? "warn" : "ok") : "down"}"><b>internet</b><em>${links}</em></span><span class="mp-arr">→</span>`;
  pathEl.innerHTML = `<div class="mp-hops">${inet}${hops}</div>
    <div class="mp-imp">${id === "NUVFW" ? `se o <b>pfSense</b> cair: o túnel cai (${esc(SITE)} inteiro fica sem visibilidade no Zabbix e sem acesso aos servidores) e os ${SRVH.filter(h => !ehFw(h) && gwDe(h) === "NUVFW").length} servidores atrás dele ficam sem acesso de fora.` : N[id].wanNuv ? `fica na rede WAN da nuvem, ao lado dos firewalls: a saída dele para a internet não passa por nenhum pfSense.` : N[id].tipo === "firewall" ? `se o <b>${esc(N[id].nome)}</b> cair: ${(k => k.length ? esc(k.join(", ")) + (k.length > 1 ? " ficam" : " fica") : "os servidores atrás dele ficam")(SRVH.filter(h => gwDe(h) === id))} sem saída para a internet. O Zabbix continua vendo pela LAN da nuvem.` : N[id].nuvem ? `servidor da nuvem: ${esc(SITE)} chega nele por ${esc(RTRH)} → ${esc(N[tunVia] ? N[tunVia].nome : "internet")} → túnel → pfSense.` : quebra ? `<b class="bad">caminho interrompido em ${esc(quebra.nome || (N[quebra.para] && N[quebra.para].nome) || "")}</b> · ` : ""}${N[id].nuvem ? "" : dep.length || ncam
      ? `se <b>${esc(N[id].nome)}</b> cair, perdem conexão: ${Object.entries(tipos).map(([t, q]) => `${q} ${TN[t] || t}`).join(", ")}` : `nada depende de ${esc(N[id].nome)} no mapa`}</div>`;
}
selecionar(S.sel && N[S.sel] ? S.sel : null);
const legEl = root.querySelector(".mp-leg"); if (legEl) legEl.addEventListener("toggle", () => { S.legAberta = legEl.open; });
/* --- navegação: roda do mouse = zoom no ponto do cursor, arrastar = mover, botões +, − e ⤢ (ver tudo) ---
 * O zoom fica guardado entre as atualizações do painel (a tela é redesenhada a cada refresh). */
const zl = root.querySelector(".mp-zl"), wrapEl = root.querySelector(".mp-wrap");
if (wrapEl) { const topo = wrapEl.getBoundingClientRect().top - (root.getBoundingClientRect().top || 0);
  wrapEl.style.height = Math.max(420, Math.min(1600, (window.innerHeight || 900) - Math.max(topo, 60) - 20)) + "px"; }
// a janela (viewBox) tem sempre a proporção do quadro: "ver tudo" usa o quadro inteiro, mapa largo ou alto
const AR = (() => { const r = svg.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? r.height / r.width : VH / VW; })();
const caixa = (x0, y0, x1, y1, m) => { let w = x1 - x0 + 2 * m, h = y1 - y0 + 2 * m; if (h / w > AR) w = h / AR; else h = w * AR;
  return { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h / 2, w, h }; };
const FIT = caixa(0, 0, VW, VH, 0), WMIN = FIT.w / 8, WMAX = FIT.w * 3;
if (!S.vb || (S.vbKey !== `${VW}x${VH}` && !S.foco)) S.vb = Object.assign({}, FIT);
S.vbKey = `${VW}x${VH}`;
if (S.foco && pos[S.foco]) {   // abriu/fechou as câmeras de um switch: enquadra o switch e as câmeras dele
  const ids = [S.foco, ...N[S.foco].filhos.filter(c => (N[c].tipo === "camera" || N[c].tipo === "servidor") && pos[c])], ps = ids.map(x => pos[x]);
  if (ids.length > 1) S.vb = caixa(Math.min(...ps.map(p => p.x)), Math.min(...ps.map(p => p.y)), Math.max(...ps.map(p => p.x)) + W, Math.max(...ps.map(p => p.y)) + H + 20, 50);
  else { const p = pos[S.foco], v = S.vb; v.x = p.x + W / 2 - v.w / 2; v.y = p.y + H / 2 - v.w * AR / 2; } }
S.foco = null;
const aplicaVB = () => {
  const v = S.vb; v.w = Math.min(Math.max(v.w, WMIN), WMAX); v.h = v.w * AR;
  v.x = Math.min(Math.max(v.x, -v.w * 0.9), VW - v.w * 0.1); v.y = Math.min(Math.max(v.y, -v.h * 0.9), VH - v.h * 0.1);
  svg.setAttribute("viewBox", `${v.x.toFixed(1)} ${v.y.toFixed(1)} ${v.w.toFixed(1)} ${v.h.toFixed(1)}`);
  if (zl) zl.textContent = `${Math.round(FIT.w / v.w * 100)}%`;
};
const zoomEm = (cx, cy, k) => {   // cx, cy em coordenadas da tela; k < 1 aproxima
  const r = svg.getBoundingClientRect(), v = S.vb;
  const px = v.x + (cx - r.left) / r.width * v.w, py = v.y + (cy - r.top) / r.height * v.h;
  const nw = Math.min(Math.max(v.w * k, WMIN), WMAX), f = nw / v.w;
  v.x = px - (px - v.x) * f; v.y = py - (py - v.y) * f; v.w = nw; aplicaVB();
};
aplicaVB();
svg.addEventListener("wheel", e => { e.preventDefault(); zoomEm(e.clientX, e.clientY, e.deltaY < 0 ? 0.85 : 1 / 0.85); }, { passive: false });
let arr = null;
svg.addEventListener("pointerdown", e => { if (e.button !== 0) return; arr = { x: e.clientX, y: e.clientY, vx: S.vb.x, vy: S.vb.y, moveu: false }; });
svg.addEventListener("pointermove", e => {
  if (!arr) return;
  const dx = e.clientX - arr.x, dy = e.clientY - arr.y;
  if (!arr.moveu && Math.abs(dx) + Math.abs(dy) < 5) return;          // pequeno movimento = clique
  if (!arr.moveu) { arr.moveu = true; svg.setPointerCapture(e.pointerId); svg.classList.add("arrastando"); tip.style.display = "none"; }
  const r = svg.getBoundingClientRect();
  S.vb.x = arr.vx - dx / r.width * S.vb.w; S.vb.y = arr.vy - dy / r.height * S.vb.h; aplicaVB();
});
const solta = () => { if (arr && arr.moveu) S.arrastou = Date.now(); arr = null; svg.classList.remove("arrastando"); };
svg.addEventListener("pointerup", solta); svg.addEventListener("pointercancel", solta);
root.onclick = e => {
  const sp = e.target.closest("[data-srv]");
  if (sp) { if (S.arrastou && Date.now() - S.arrastou < 300) return; S.f.srv = !S.f.srv; salvaF(); S.foco = "NUVFW"; desenhar(); return; }
  const cp = e.target.closest("[data-cam]");
  if (cp) { if (S.arrastou && Date.now() - S.arrastou < 300) return; const k = cp.dataset.cam;
    if (S.camAbre[k]) delete S.camAbre[k]; else S.camAbre[k] = true; S.foco = k; desenhar(); return; }
  const fb = e.target.closest("[data-f]");
  if (fb) { const k = fb.dataset.f; if (k === "cam") S.f.cam = { cont: "det", det: "off", off: "cont" }[S.f.cam];
    else if (k === "lay") { S.f.lay = MODO === "col" ? "arvore" : "col"; S.vb = null; }
    else if (k === "area") { const ord = ["tudo", "sede", ...AREAS.map(a => a.id)]; S.f.area = ord[(ord.indexOf(S.f.area) + 1) % ord.length]; }
    else S.f[k] = !S.f[k];
    salvaF(); desenhar(); return; }
  const z = e.target.closest("[data-z]");
  if (z && z.dataset.z === "side") { S.f.side = !S.f.side; salvaF(); S.vb = null; desenhar(); return; }
  if (z) { const r = svg.getBoundingClientRect(); if (z.dataset.z === "fit") { S.vb = Object.assign({}, FIT); aplicaVB(); } else zoomEm(r.left + r.width / 2, r.top + r.height / 2, z.dataset.z === "in" ? 0.75 : 1 / 0.75); return; }
  if (S.arrastou && Date.now() - S.arrastou < 300) return;            // fim de um arraste: não é clique
  const g = e.target.closest("[data-n]"); selecionar(g ? (S.sel === g.dataset.n ? null : g.dataset.n) : null);
};

root.style.position = "relative";
let tip = root.querySelector(".nk-card"); if (!tip) { tip = document.createElement("div"); tip.className = "nk-card"; root.appendChild(tip); }
const row = (k, v) => `<div class="nk-row"><span>${k}</span><span>${v}</span></div>`;
function detNo(n) {
  const l = LBY[n.id], o = HOST[n.host] || {};
  return `<div class="nk-head" style="border-color:${COLR[n.st]}"><div><b>${esc(n.nome)}</b><div class="nk-sub">${esc(n.host || "")} · ${esc(n.sub || "")}</div></div></div>
    <div class="nk-sec">${row("Estado", esc(n.causa ? "fora (" + causaTxt(n) + ")" : n.why))}
      ${o.ping != null ? row("Ping", o.ping === 1 ? "ok" : "sem resposta") : ""}${o.snmp != null ? row("SNMP", o.snmp === 1 ? "ok" : o.snmp === 0 ? "sem resposta" : "desconhecido") : ""}${o.ag != null ? row("Agente Zabbix", o.ag === 1 ? "ok" : o.ag === 0 ? "sem resposta" : "desconhecido") : ""}
      ${n.id === "NUVFW" ? row("Servidores atrás", `${SRV.length}${SRV.filter(x => x.st === "down").length ? " · " + SRV.filter(x => x.st === "down").length + " fora" : ""}`) + row("Túnel com " + SITE, tunSt === 1 ? "no ar" : tunSt === 0 ? "FORA" : "sem dados") : ""}
      ${l ? row("Ligado em", `${esc(N[l.de].nome)} · ${esc(l.tunel ? "túnel" : portLbl(l))}`) : ""}${l && l.p ? row("Tráfego ↓ / ↑", `${bps(l.down)} / ${bps(l.up)}`) : ""}
      ${desc(n.id).length ? row("Dependem dele", desc(n.id).length) : ""}${camsDe(n.id).length ? row("Câmeras ligadas", `${camsDe(n.id).length}${camsDe(n.id).filter(camFora).length ? " · " + camsDe(n.id).filter(camFora).length + " fora" : ""}`) : ""}</div>
    ${camsDe(n.id).filter(c => c.st !== "ok").length ? `<div class="nk-sec"><div class="nk-t">Câmeras sem resposta</div>${camsDe(n.id).filter(c => c.st !== "ok").sort((a, b) => a.p - b.p).slice(0, 10).map(c => `<div class="nk-pr"><span class="sev" style="color:${COLR[c.st]}">p${c.p}</span>${esc(c.host)}${c.st === "unk" ? " (sem dados)" : ""}</div>`).join("")}</div>` : ""}
    ${n.pr && n.pr.length ? `<div class="nk-sec"><div class="nk-t">Problemas (${n.pr.length})</div>${n.pr.map(p => `<div class="nk-pr"><span class="sev" style="color:${SEVC[p.sev]}">${SEV[p.sev]}</span>${esc(p.p)}<span class="nk-age">${age(p.ts)}</span></div>`).join("")}</div>` : ""}`;
}
function detLink(l) {
  const a = N[l.de], b = N[l.para], p = l.p;
  if (l.tunel) return `<div class="nk-head" style="border-color:${l.st === "ok" ? "#a78bfa" : COLR[l.st]}"><div><b>Túnel ${esc(SITE)} ↔ nuvem</b><div class="nk-sub">${esc(a.nome)} ⇄ ${esc(b.nome)}</div></div></div>
    <div class="nk-sec">${row("Túnel", tunSt === 1 ? "no ar" : tunSt === 0 ? "FORA" : "sem dados")}${row("Saindo por", esc(a.nome) + (NUVEM.via[0] === l.de ? " (principal)" : " (contingência)"))}${row("pfSense", b.st === "down" ? "fora" : b.st === "unk" ? "sem dados" : "respondendo")}
      ${p ? row("Nuvem → " + SITE + " ↓", bps(l.down)) + row(SITE + " → nuvem ↑", bps(l.up)) : ""}
      <div class="nk-empty">Estado = ping do Zabbix até o roteador pelo túnel (item "Túnel até a RB: disponível"). Tráfego = interface ${esc(NUVEM.tunIf)} do roteador${p ? "" : " (não encontrada)"}.</div></div>`;
  if (l.lan) return `<div class="nk-head" style="border-color:${COLR[l.st]}"><div><b>${esc(a.nome)} → ${esc(b.nome)}</b><div class="nk-sub">rede interna da nuvem</div></div></div>
    <div class="nk-sec">${row("Servidor", b.st === "down" ? "sem resposta" : b.st === "unk" ? "sem dados" : "respondendo")}<div class="nk-empty">Ligação lógica (VMs atrás do pfSense): não há porta para ler.</div></div>`;
  return `<div class="nk-head" style="border-color:${COLR[l.st]}"><div><b>${esc(a.nome)} → ${esc(b.nome)}</b><div class="nk-sub">${esc(portLbl(l))}${l.trunk ? " · trunk" : ""}${p ? " · porta lida em " + esc(l.lado === "de" ? a.nome : b.nome) + " (" + esc(p.n) + ")" : ""}</div></div></div>
    ${l.wifi ? `<div class="nk-sec">${row("Ligação", "sem fio (Wi-Fi)")}${row("Estado", b.st === "down" ? "equipamento sem resposta" : b.st === "unk" ? "sem dados" : "equipamento respondendo")}<div class="nk-empty">Sem fio não há porta de switch para ler: tráfego e uso não aparecem.</div></div>` : ""}
    ${l.wifi ? "" : `<div class="nk-sec">${l.caiuPor ? row("Motivo", esc(N[l.caiuPor].nome) + " sem resposta") : ""}${row("Status da porta", l.caiuPor ? "sem valor confiável (equipamento fora)" : !p || p.st == null ? "sem dados" : p.st === 1 ? "up" : "DOWN")}
      ${row("Para baixo ↓", bps(l.down))}${row("Para cima ↑", bps(l.up))}${row("Velocidade", p && p.sp ? kb(p.sp) : "—")}${row("Uso", l.util == null ? "—" : l.util.toFixed(1) + "%")}</div>`}`;
}
let tipFor = null;
root.onmousemove = e => {
  const n = e.target.closest(".mp-n,.mp-chip"), ed = !n && e.target.closest(".mp-e");
  const key = n ? "n" + n.dataset.n : ed ? "e" + ed.dataset.e : null;
  if (!key) { tip.style.display = "none"; tipFor = null; return; }
  if (tipFor !== key) { tip.innerHTML = n ? detNo(N[n.dataset.n]) : detLink(LBY[ed.dataset.e]); tipFor = key; }
  tip.style.display = "block";
  posTip(tip, e, root, 16);
};
root.onmouseleave = () => { tip.style.display = "none"; tipFor = null; };

}
desenhar();

/* posição do cartão do cursor: dentro da área VISÍVEL do painel (o Grafana corta o que passa da borda do painel, não da janela) */
function posTip(tip, e, root, dx) {
  const B = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  for (let p = root; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (/(hidden|auto|scroll|clip)/.test(cs.overflow + cs.overflowX + cs.overflowY)) { const q = p.getBoundingClientRect();
      B.left = Math.max(B.left, q.left); B.top = Math.max(B.top, q.top); B.right = Math.min(B.right, q.right); B.bottom = Math.min(B.bottom, q.bottom); }
  }
  tip.style.maxHeight = Math.max(120, B.bottom - B.top - 16) + "px"; tip.style.overflowY = "auto";
  const r = root.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
  let vx = e.clientX + dx, vy = e.clientY + 12;
  if (vx + tw > B.right - 8) vx = e.clientX - tw - dx;     // sem espaço à direita: abre à esquerda do cursor
  if (vx < B.left + 8) vx = B.left + 8;
  if (vy + th > B.bottom - 8) vy = e.clientY - th - 12;    // sem espaço embaixo: abre acima
  if (vy + th > B.bottom - 8) vy = B.bottom - 8 - th;
  if (vy < B.top + 8) vy = B.top + 8;
  tip.style.left = (vx - r.left + root.scrollLeft) + "px"; tip.style.top = (vy - r.top + root.scrollTop) + "px";
}

