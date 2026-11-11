const DRILL_UID = NOC.detalhe_uid;   // duplo clique no card abre este dashboard
/* NOC Servidores - Business Text (afterRender)
 * Lê as queries do painel (refId):
 *   A = disponibilidade do agente   B = CPU   C = memória
 *   D = espaço em disco (% usado)   E = uptime   F = problemas (query de Problems)
 *   H = sites (hosts SSL-*): falha do scenario, tempo de resposta e vencimento do certificado
 *   G = detalhes p/ o card de hover: núcleos, memória total/usada, swap, processos,
 *       fila de CPU/load e tráfego de rede (Bits received/sent)
 *       + firewall pfSense (SNMP): tabela de estados (conexões), regras, status do PF
 *         e status/tráfego por interface. Hosts com "States table" viram card de firewall.
 * Para mudar limites de cor: LIMITE_ATENCAO / LIMITE_CRITICO.
 * Para mudar a rotação do destaque: ROTACAO_MS.
 */
const LIMITE_ATENCAO = 80, LIMITE_CRITICO = 90, ROTACAO_MS = 8000;
const ATRASO_MAX_MIN = 5;      // acima disso, faixa vermelha de "dados atrasados"
const CERT_ALERTA_DIAS = 7;    // certificado laranja abaixo disso; vermelho só depois de vencido (ou site fora)

/* --- compatibilidade entre versões do plugin --- */
const ctx = (typeof context !== "undefined") ? context : {};
const root0 = ctx.element || (typeof element !== "undefined" ? element : document);
const root = (root0.querySelector && root0.querySelector(".noc")) || root0;
// procura os data frames onde quer que a versão do plugin os coloque
const isFrames = a => Array.isArray(a) && a.length && a[0] && Array.isArray(a[0].fields);
function findSeries(o, depth, seen) {
  if (!o || typeof o !== "object" || depth > 4 || seen.has(o)) return null;
  seen.add(o);
  if (isFrames(o.series)) return o.series;
  if (isFrames(o)) return o;
  for (const k of ["panel", "panelData", "data", "series"]) { const r = findSeries(o[k], depth + 1, seen); if (r) return r; }
  return null;
}
const series = findSeries(ctx, 0, new Set())
  || (typeof panelData !== "undefined" ? findSeries(panelData, 0, new Set()) : null)
  || (typeof data !== "undefined" ? findSeries(data, 0, new Set()) : null) || [];
const ctxInfo = `context: ${Object.keys(ctx).join(", ")}\ncontext.panel: ${ctx.panel ? Object.keys(ctx.panel).join(", ") : "-"}\ncontext.data: ${Array.isArray(ctx.data) ? "array(" + ctx.data.length + ")" : typeof ctx.data}`;

/* --- helpers --- */
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const vals = f => !f ? [] : (Array.isArray(f.values) ? f.values : (f.values && f.values.toArray ? f.values.toArray() : []));
const lastNN = arr => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null && !Number.isNaN(arr[i])) return arr[i]; return null; };
function seriesName(frame, field) {
  const c = field.config || {};
  return c.displayNameFromDS || c.displayName || (field.state && field.state.displayName) || frame.name || field.name || "";
}
function hostOf(frame, field, name) {
  const l = field.labels || {};
  return l.host || l.host_name || (name.includes(": ") ? name.split(": ")[0] : name);
}
function itemOf(field, name) {
  const l = field.labels || {};
  return l.item || (name.includes(": ") ? name.split(": ").slice(1).join(": ") : name);
}

// sistemas de arquivos virtuais (sempre 100% e sem significado): devfs do pfSense em chroots, /proc, /sys, /run, shm
const PSEUDO_FS = /(^|\/)dev(\/|$)|^\/(proc|sys|run)(\/|$)|\/shm$/i;
const MAX_DISCOS = 2;   // discos mostrados no card (os mais cheios); todos aparecem no detalhe ao passar o mouse
function diskName(item) {
  let t = item.replace(/^(Windows|Linux):\s*/i, "").replace(/:?\s*(Space utilization|Space: Used, in %|Used space in %).*$/i, "");
  let m = t.match(/^(.*?)\s*\(([A-Z]:)\)\s*$/); if (m) return m[2] + (m[1] ? " " + m[1] : "");
  m = t.match(/\[([^\]]+)\]/); if (m) { const x = m[1].match(/\(([A-Z]:)\)/); return x ? x[1] + (m[1].replace(/\([A-Z]:\)/, '').trim() ? ' ' + m[1].replace(/\([A-Z]:\)/, '').trim() : '') : m[1]; }
  return t.replace(/^FS\s*/i, "").replace(/:$/, "") || item;
}

/* --- leitura das métricas --- */
const H = {};
const host = n => (H[n] = H[n] || { n, os: "", st: null, cpu: null, mem: null, disks: {}, up: null, cpuH: [], memH: [], x: {}, rx: null, tx: null, ifs: {}, fw: false });
let problems = [];
const debug = [];
let newest = 0;                      // último timestamp recebido (ms) - para detectar tela congelada
const SITES = {};
for (const fr of series) {
  const ref = fr.refId || "";
  const tf = (fr.fields || []).find(f => f.type === "time");
  if (tf && ref !== "F" && ref !== "H") { const t = lastNN(vals(tf)); if (t > newest) newest = t; }
  for (const f of fr.fields || []) {
    const v = vals(f);
    debug.push(`[${ref}] frame="${fr.name || ""}" field="${f.name}" type=${f.type} labels=${JSON.stringify(f.labels || {})} n=${v.length}`);
    if (ref === "F") {
      // problemas: campo com objetos (formato do plugin) ou tabela
      if (v.length && typeof v[0] === "object" && v[0] !== null) problems = problems.concat(v);
      continue;
    }
    if (f.type !== "number") continue;
    const name = seriesName(fr, f), h = hostOf(fr, f, name), item = itemOf(f, name), x = lastNN(v);
    if (!h) continue;
    if (ref === "H") {
      const key = h.replace(/^SSL-/i, "").replace(/\.$/, "");
      const o = SITES[key] = SITES[key] || { n: key, fail: null, rt: null, exp: null, https: false, rtH: false };
      const isH = /HTTPS/i.test(item);
      if (/Failed step of scenario/i.test(item)) { if (isH || !o.https) { o.fail = x; if (isH) o.https = true; } }
      else if (/Response time for step/i.test(item)) { if (isH || !o.rtH) { o.rt = x; if (isH) o.rtH = true; } }
      else if (/Expires on/i.test(item)) o.exp = x;
      continue;
    }
    const o = host(h);
    if (/^Windows/i.test(item)) o.os = "Windows"; else if (/^Linux/i.test(item)) o.os = "Linux";
    // A: disponibilidade do agente/SNMP e ICMP (mesma escala: 1 = ok, 0 = fora). Vale o pior: ping 0 derruba o card.
    if (ref === "A") o.st = (o.st == null || x === 0 || (o.st === 2 && x === 1)) ? x : o.st;
    else if (ref === "B") { o.cpu = x; o.cpuH = v.filter(n => n != null).slice(-60); }
    else if (ref === "C") {
      if (/swap|virtual/i.test(item)) continue;
      const phys = /physical/i.test(item);
      if (phys || !o.memPhys) { o.mem = x; o.memH = v.filter(n => n != null).slice(-60); if (phys) o.memPhys = true; }
    }
    else if (ref === "E") o.up = x;
    else if (ref === "D") { const dn = diskName(item); if (!PSEUDO_FS.test(dn)) o.disks[dn] = x; }
    else if (ref === "G") {
      const it = item.replace(/^(Windows|Linux):\s*/i, "");
      const wm = it.match(/^WAN\s+(.+?):\s*internet\b/i);
      if (wm) { o.wan = o.wan || {}; o.wan[wm[1].trim().toUpperCase()] = x; continue; }
      const ifm = it.match(/Interface\s+\[?(.+?)\]?:\s*(Bits received|Bits sent|Operational status)/i);
      if (ifm) {
        const n = ifm[1], skip = /^(lo|pflog|pfsync|enc|ovpn[cs]?\d*$)/i.test(n);
        const I = o.ifs[n] = o.ifs[n] || { rx: null, tx: null, st: null };
        if (/received/i.test(ifm[2])) { I.rx = x; if (!skip) o.rx = (o.rx || 0) + (x || 0); }
        else if (/sent/i.test(ifm[2])) { I.tx = x; if (!skip) o.tx = (o.tx || 0) + (x || 0); }
        else I.st = x;
      }
      else if (/Bits received/i.test(it)) o.rx = (o.rx || 0) + (x || 0);
      else if (/Bits sent/i.test(it)) o.tx = (o.tx || 0) + (x || 0);
      else if (/States table current/i.test(it)) { o.x.states = x; o.fw = true; }
      else if (/States table limit/i.test(it)) { o.x.statesMax = x; o.fw = true; }
      else if (/States table utilization/i.test(it)) { o.x.statesPct = x; o.fw = true; }
      else if (/Source tracking table current/i.test(it)) o.x.srcTrack = x;
      else if (/Firewall rules count/i.test(it)) o.x.rules = x;
      else if (/Packet filter running status/i.test(it)) o.x.pf = x;
      else if (/Number of (cores|CPUs)/i.test(it)) o.x.cores = x;
      else if (/^Total memory/i.test(it)) o.x.memTotal = x;
      else if (/^Used memory/i.test(it)) o.x.memUsed = x;
      else if (/^Available memory$/i.test(it)) o.x.memAvail = x;
      else if (/swap.*%/i.test(it)) o.x.swapFree = x;
      else if (/Number of processes$/i.test(it)) o.x.procs = x;
      else if (/CPU queue length/i.test(it)) o.x.queue = x;
      else if (/Load average \(1m/i.test(it)) o.x.load = x;
      else if (/uptime/i.test(it) && o.up == null) o.up = x;
    }
  }
}
// problemas em formato de tabela (fallback)
if (!problems.length) {
  const fr = series.find(s => s.refId === "F");
  if (fr) {
    const g = n => (fr.fields || []).find(f => new RegExp(n, "i").test(f.name));
    const fh = g("^host"), fd = g("desc|name|problem"), fs = g("sever|prior"), ft = g("time|lastchange|clock");
    const len = fd ? vals(fd).length : 0;
    for (let i = 0; i < len; i++) problems.push({ host: fh && vals(fh)[i], name: vals(fd)[i], severity: fs && vals(fs)[i], lastchange: ft && vals(ft)[i] });
  }
}
const P = problems.map(p => {
  const hs = p.hosts && p.hosts[0];
  let ts = Number(p.timestamp || p.lastchange || p.clock || 0); if (ts > 1e12) ts = ts / 1000;
  // hm = o HOST está em manutenção; mt = este problema não conta (host em manutenção OU problema silenciado à mão)
  const hm = p.maintenance === true || p.maintenance === 1 || p.maintenance === "1" || !!(hs && (hs.maintenance_status == 1 || hs.maintenance === true));
  const mt = hm || p.suppressed == 1 || p.suppressed === "1";
  return { h: (hs && (hs.name || hs.host)) || p.host || "?", p: p.name || p.description || "", sev: Number(p.severity != null ? p.severity : p.priority) || 0, ts, mt, hm };
});
const MAINT = new Set(P.filter(p => p.hm).map(p => p.h));     // hosts em manutenção (vistos pelos problemas)
const PA = P.filter(p => !p.mt);                               // problemas que contam
// um problema silenciado (ou uma manutenção só de um alerta) não pinta o card inteiro de cinza: o card segue o estado real
// do host; o cinza fica só para host em manutenção que está fora do ar (queda esperada)
const silenc = n => P.filter(p => p.h === n && p.mt).length;

const S = Object.values(H).sort((a, b) => a.n.localeCompare(b.n));
S.forEach(s => { if (s.fw && !s.os) s.os = "pfSense"; const d = Object.values(s.disks).filter(x => x != null); s.disk = d.length ? Math.max(...d) : null; });

/* --- sem dados: modo diagnóstico --- */
if (!S.length) {
  root.innerHTML = `<div class="dbg">NOC: nenhum servidor reconhecido nas queries.\nTire um print desta caixa e envie.\n\n${esc(debug.join("\n") || "Nenhum dado recebido (confira as queries e o datasource).")}\n\n${esc(ctxInfo)}</div>`;
  return;
}

/* --- regras de estado --- */
const SEV = ["Not classified", "Information", "Warning", "Average", "High", "Disaster"];
const SEVC = ["#6b7280", "#38bdf8", "#f5b301", "#fb923c", "#ef4444", "#b91c1c"];
const online = s => s.st === 1;          // 1 = disponível, 0 = indisponível, 2 = desconhecido
function state(s) {
  if (MAINT.has(s.n) && s.st === 0) return "maint";
  if (s.st === 0) return "down";          // fora do ar (agente/ping sem resposta): fundo vermelho
  const m = PA.filter(x => x.h === s.n).map(x => x.sev);
  if (!m.length) return (s.st === 2 || s.st == null) ? "warn" : "ok";
  return Math.max(...m) >= 4 ? "crit" : "warn";
}
const lvl = v => v == null ? "" : v >= LIMITE_CRITICO ? "c" : v >= LIMITE_ATENCAO ? "w" : "";
const pct = v => v == null ? "—" : (v < 1 ? v.toFixed(1) : v.toFixed(0)) + "%";
const dur = sec => { if (sec == null) return "—"; sec = Math.floor(sec); const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
const age = ts => ts ? dur(Date.now() / 1000 - ts) : "";
const bar = (n, v, off, t) => `<div class="m"><span class="n" title="${esc(t || n)}">${esc(n)}</span><div class="track"><div class="fill ${lvl(v)}" style="width:${off ? 0 : (v || 0)}%"></div></div><span class="val">${off ? "—" : pct(v)}</span></div>`;
const stLabel = s => MAINT.has(s.n) && s.st === 0 ? "● manutenção" : s.st === 1 ? "● online" : s.st === 0 ? "● offline" : "● desconhecido";

// um bar por disco, do mais cheio para o mais vazio (rótulo curto: "C:", "/var"...)
const shortDisk = k => (k.match(/^([A-Z]:)/) || [k])[0].slice(0, 7);
function diskBars(s, off) {
  const d = Object.entries(s.disks).sort((a, b) => (b[1] || 0) - (a[1] || 0));
  if (!d.length) return bar("DISCO", null, true);
  const mais = d.length - MAX_DISCOS;
  return `<div class="disks">${d.slice(0, MAX_DISCOS).map(([k, v]) => bar(shortDisk(k), v, off, "Disco " + k)).join("")}${mais > 0 ? `<div class="dmore">+${mais} disco${mais > 1 ? "s" : ""} (ver detalhe)</div>` : ""}</div>`;
}

const num = n => n == null ? "—" : Math.round(n).toLocaleString("pt-BR");
const kbps = b => b == null ? "—" : b >= 1e9 ? (b / 1e9).toFixed(1) + "G" : b >= 1e6 ? (b / 1e6).toFixed(1) + "M" : b >= 1e3 ? (b / 1e3).toFixed(0) + "K" : Math.round(b) + "";
// links de internet do roteador: estado pelo teste da RB; tráfego pela interface cujo nome/descrição cita o link (ex.: "ether1(WAN-BETA ...)")
function wanRows(s, off) {
  if (!s.wan) return "";
  return `<div class="wanb">${Object.keys(s.wan).sort().map(k => { const v = s.wan[k];
    const ik = Object.keys(s.ifs).find(n => n.toUpperCase().includes(k)), I = ik ? s.ifs[ik] : null;
    const tr = I && (I.rx != null || I.tx != null) ? ` <span class="tr">↓${kbps(I.rx)} ↑${kbps(I.tx)}</span>` : "";
    return `<div class="fwl wan" title="${esc(k)}: internet testada pelo próprio roteador${ik ? " · interface " + esc(ik) : ""}"><span><i class="wd ${off || v == null ? "" : v === 1 ? "up" : "dn"}"></i>${esc(k)}</span><b class="${off || v == null ? "" : v === 1 ? "okc" : "bad"}">${off || v == null ? "—" : v === 1 ? "ok" + tr : "SEM INTERNET"}</b></div>`; }).join("")}</div>`;
}
function statesPct(s) { const x = s.x; return x.statesPct != null ? x.statesPct : (x.states != null && x.statesMax ? x.states / x.statesMax * 100 : null); }
function fwBars(s, off) {
  const x = s.x;
  return `${s.cpu != null ? bar("CPU", s.cpu, off) : ""}${s.mem != null ? bar("MEM", s.mem, off) : ""}
    ${bar("CONEX.", statesPct(s), off, "Uso da tabela de estados (conexões ativas)")}
    <div class="fwl"><span>Conexões</span><b>${off ? "—" : num(x.states)}</b></div>
    <div class="fwl"><span>Tráfego ↓</span><b>${off ? "—" : bps(s.rx)}</b></div>
    <div class="fwl"><span>Tráfego ↑</span><b>${off ? "—" : bps(s.tx)}</b></div>
    <div class="fwl"><span>Filtro PF</span><b class="${x.pf === 1 ? "okc" : x.pf == null ? "" : "bad"}">${x.pf === 1 ? "rodando" : x.pf == null ? "—" : "PARADO"}</b></div>`;
}

const bytes = b => { if (b == null) return "—"; const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } return b.toFixed(i >= 3 ? 1 : 0) + " " + u[i]; };
const bps = b => { if (b == null) return "—"; const u = ["bps", "Kbps", "Mbps", "Gbps"]; let i = 0; while (b >= 1000 && i < 3) { b /= 1000; i++; } return b.toFixed(i ? 1 : 0) + " " + u[i]; };
/* --- KPIs --- */
const SM = S.filter(s => !(MAINT.has(s.n) && s.st === 0)), nMaint = S.length - SM.length;
const live = SM.filter(online), N = SM.length;
const avg = k => { const a = live.map(s => s[k]).filter(x => x != null); return a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(0) : "—"; };
const memHi = live.filter(s => s.mem != null && s.mem >= 85).length;
const d85 = S.reduce((n, s) => n + Object.values(s.disks).filter(x => x != null && x >= 85).length, 0);
const hi = PA.filter(p => p.sev >= 4).length, alert = SM.filter(s => state(s) !== "ok").length;

/* IP dos servidores. Não existe item de IP no Zabbix para esses hosts, então a lista é mantida à mão.
   Mesma conferência da tabela do mapa (Zabbix → Data collection → Hosts, interface), 2026-10-29. Host novo ou IP trocado: ajustar aqui e no mapa.
   O firewall mostra o IP de LAN (as demais interfaces ficam fora). RTR-SEDE não tem IP cadastrado nesta lista. */
const IPS = NOC.ips || {};   // IP de cada host, do noc.yaml (não há item de IP nos hosts)
const ipOf = n => IPS[n] || "";

/* --- cards --- */
const ord = { down: 0, crit: 1, warn: 2, ok: 3, maint: 4 };
const cardsHtml = [...S].sort((a, b) => ord[state(a)] - ord[state(b)] || a.n.localeCompare(b.n)).map(s => {
  const st = state(s), off = !online(s), top = PA.filter(p => p.h === s.n).sort((a, b) => b.sev - a.sev)[0];
  const issue = st === "maint" ? "EM MANUTENÇÃO" : s.st === 0 ? "OFFLINE · agente sem resposta" : top ? top.p : "";
  return `<div class="card ${st} ${off ? "off" : ""}" data-n="${esc(s.n)}">
    <div class="ch"><span class="dot"></span>${esc(s.n)}</div>
    <div class="sub">${esc(s.os || "—")} · uptime ${off ? "—" : dur(s.up)}${MAINT.has(s.n) && st !== "maint" ? ' · <span class="mtag">manutenção</span>' : ""}</div>
    ${ipOf(s.n) ? `<div class="sub ipl" title="Endereço IP">${esc(ipOf(s.n))}</div>` : ""}
    ${issue ? `<div class="issue" title="${esc(issue)}">${esc(issue)}</div>` : ""}
    ${s.fw ? fwBars(s, off) : `${bar("CPU", s.cpu, off)}${bar("MEM", s.mem, off)}${diskBars(s, off)}`}${wanRows(s, off)}
    <div class="foot"><span>${stLabel(s)}</span><span>${PA.filter(p => p.h === s.n).length} problema(s)${silenc(s.n) ? ` · <span class="mtag">${silenc(s.n)} silenciado(s)</span>` : ""}</span></div></div>`;
}).join("");

const Q = [...P].sort((a, b) => (a.mt - b.mt) || b.sev - a.sev || b.ts - a.ts);
const queueHtml = Q.length ? Q.map(p => `<li data-n="${esc(p.h)}" class="${p.mt ? "mt" : ""}"><span class="bar" style="background:${p.mt ? "#6b7280" : SEVC[p.sev] || SEVC[0]}"></span>
  <div><div class="h">${esc(p.h)}${p.mt ? ` <span class="mtag">${p.hm ? "manutenção" : "silenciado"}</span>` : ""}</div><div class="p"><span class="sev" style="color:${SEVC[p.sev] || SEVC[0]}">${SEV[p.sev] || ""}</span>${esc(p.p)}</div></div><span class="t">${age(p.ts)}</span></li>`).join("")
  : `<li class="empty">Nenhum problema ativo.</li>`;

/* --- sites e certificados --- */
const nowS = Date.now() / 1000;
const diasCert = x => x.exp != null ? (x.exp - nowS) / 86400 : null;
const siteState = x => { const d = diasCert(x);
  return (x.fail != null && x.fail > 0) || (d != null && d < 0) ? "crit" : d != null && d < CERT_ALERTA_DIAS ? "cert" : x.fail == null ? "unk" : "ok"; };
const ORD_SITE = { crit: 0, cert: 1, warn: 2, unk: 3, ok: 4 };
// ordem: vencimento do certificado, do que vence primeiro para o que vence por último (vencidos antes de todos; sem data de certificado, no fim).
// Site fora do ar assume sempre o primeiro lugar (queda não pode ficar escondida no meio da lista só por ter certificado novo); entre os fora, vale a mesma ordem de vencimento.
const venc = x => { const d = diasCert(x); return d == null ? Infinity : d; };
const SL = Object.values(SITES).sort((a, b) => ((a.fail > 0 ? 0 : 1) - (b.fail > 0 ? 0 : 1)) || (venc(a) - venc(b)) || a.n.localeCompare(b.n));
const sitesUp = SL.filter(x => x.fail === 0).length, certSoon = SL.filter(x => diasCert(x) != null && diasCert(x) >= 0 && diasCert(x) < CERT_ALERTA_DIAS).length, certVenc = SL.filter(x => diasCert(x) != null && diasCert(x) < 0).length;
const sitesHtml = SL.length ? `<section class="sites"><div class="sh"><b>Sites</b><span>${sitesUp}/${SL.length} no ar · por vencimento do certificado${certVenc ? ` · <em class="bad">${certVenc} certificado(s) VENCIDO(S)</em>` : ""}${certSoon ? ` · <em>${certSoon} certificado(s) vencendo em &lt; ${CERT_ALERTA_DIAS} dias</em>` : ""}</span></div>
  <div class="chips">${SL.map(x => { const st = siteState(x), d = x.exp != null ? Math.floor((x.exp - nowS) / 86400) : null;
    return `<div class="chip ${st}" title="${esc(x.n)}${x.fail > 0 ? " · FALHOU no step " + x.fail : ""}"><span class="dot"></span><span class="sn">${esc(x.n)}</span>
      <span class="sm">${x.fail > 0 ? "FORA" : x.rt != null ? Math.round(x.rt * 1000) + " ms" : "—"}</span><span class="sm ${d != null && d < 0 ? "venc" : d != null && d < CERT_ALERTA_DIAS ? "hot" : ""}" title="${d != null ? (d < 0 ? "certificado vencido há " + -d + " dia(s)" : "certificado vence em " + d + " dia(s)") : ""}">${d != null ? (d < 0 ? "🔒 VENCIDO" : "🔒 " + d + "d") : ""}</span></div>`; }).join("")}</div></section>` : "";

const K = [
  ["Servidores online", `${live.length}<span> / ${N}</span>`, live.length < N ? "crit" : "ok", `${N - live.length} fora do ar${nMaint ? ` · ${nMaint} em manutenção` : ""}`],
  ["Em alerta", alert, alert ? "warn" : "ok", "com problema ativo"],
  ["Sites no ar", SL.length ? `${sitesUp}<span> / ${SL.length}</span>` : "—", !SL.length ? "" : sitesUp < SL.length || certVenc ? "crit" : certSoon ? "warn" : "ok", certVenc ? `${certVenc} certificado(s) vencido(s)` : certSoon ? `${certSoon} certificado(s) vencendo` : `CPU média ${avg("cpu")}%`],
  ["Memória média", `${avg("mem")}<span>%</span>`, memHi ? "warn" : "", `${memHi} acima de 85%`],
  ["Discos ≥ 85%", d85, d85 ? "warn" : "ok", "filesystems"],
  ["Problemas ativos", PA.length, hi ? "crit" : PA.length ? "warn" : "ok", `${hi} High/Disaster`]
];

/* --- tela congelada? --- */
const fmtH = ms => new Date(ms).toLocaleTimeString("pt-BR");
const atrasoMin = newest ? (Date.now() - newest) / 60000 : null;
const staleHtml = atrasoMin != null && atrasoMin > ATRASO_MAX_MIN
  ? `<div class="stale">⚠ DADOS ATRASADOS — a última coleta recebida é de ${fmtH(newest)} (há ${Math.round(atrasoMin)} min). O que está na tela pode não refletir a situação atual. Verifique o Zabbix server e o datasource do Grafana.</div>` : "";
const topHtml = `<div class="topbar"><span class="${staleHtml ? "bad" : ""}">● ${newest ? "dados de " + fmtH(newest) : "sem timestamp"}</span>${typeof DRILL_UID !== "undefined" && DRILL_UID ? "<span>duplo clique no card abre o detalhe do servidor</span>" : ""}<span>tela renderizada às ${fmtH(Date.now())}</span></div>`;

root.innerHTML = `${staleHtml}${topHtml}
  <section class="kpis">${K.map(k => `<div class="kpi ${k[2]}"><div class="l">${k[0]}</div><div class="v">${k[1]}</div><div class="s">${k[3]}</div></div>`).join("")}</section>
  ${sitesHtml}
  <div class="main">
    <section class="grid">${cardsHtml}</section>
    <aside class="side">
      <div class="box"><h2>Atenção <span class="c ${PA.length ? "" : "z"}" title="${P.length - PA.length ? (P.length - PA.length) + " silenciado(s) / em manutenção, em cinza na lista" : ""}">${PA.length}</span></h2><ul class="q">${queueHtml}</ul></div>
      <div class="box"><h2>Em destaque <span class="sp" style="color:var(--mute);font-weight:400"></span></h2><div class="spot"></div></div>
    </aside>
  </div>`;

/* --- destaque com rotação --- */
const W = window.__nocState = window.__nocState || {};
clearInterval(W.timer);
const spotEl = root.querySelector(".spot"), spLbl = root.querySelector(".sp");
function spot(name) {
  const s = S.find(x => x.n === name); if (!s) return;
  const st = state(s), off = !online(s), col = { down: "#ef4444", crit: "#fb923c", warn: "#f5b301", ok: "#22c55e", maint: "#6b7280" }[st];
  const pr = P.filter(p => p.h === name);
  root.querySelectorAll(".card").forEach(c => c.classList.toggle("focus", c.dataset.n === name));
  spotEl.innerHTML = `<div class="title"><b>${esc(s.n)}</b><span class="badge" style="background:${col}">${st === "maint" ? "MANUTENÇÃO" : st === "ok" ? "OK" : s.st === 0 ? "OFFLINE" : "ALERTA"}</span></div>
    <div class="sub">${esc(s.os || "—")}${ipOf(s.n) ? " · " + esc(ipOf(s.n)) : ""} · uptime ${off ? "—" : dur(s.up)}</div>
    ${bar("CPU", s.cpu, off)}${bar("MEM", s.mem, off)}${wanRows(s, off)}
    <table>${Object.entries(s.disks).sort((a, b) => (b[1] || 0) - (a[1] || 0)).slice(0, 4).map(([k, v]) => `<tr><td>Disco ${esc(k)}</td><td>${pct(v)}</td></tr>`).join("") || "<tr><td>Discos</td><td>sem dados</td></tr>"}
    ${pr.map(p => `<tr><td style="color:${p.mt ? "#6b7280" : SEVC[p.sev] || SEVC[0]}">${esc(p.p)}${p.mt ? (p.hm ? " (manutenção)" : " (silenciado)") : ""}</td><td>${age(p.ts)}</td></tr>`).join("")}</table>`;
}
let rot = [...new Set(Q.filter(p => !p.mt).map(p => p.h))].filter(n => S.some(s => s.n === n));
S.filter(s => s.st === 0 && !MAINT.has(s.n) && !rot.includes(s.n)).forEach(s => rot.unshift(s.n));
if (!rot.length) rot = S.map(s => s.n);
W.i = (W.i || 0) % rot.length;
const show = () => { const n = W.pinned && S.some(s => s.n === W.pinned) ? W.pinned : rot[W.i % rot.length]; spot(n); spLbl.textContent = W.pinned ? "fixado · clique de novo para soltar" : `rotação · ${W.i % rot.length + 1}/${rot.length}`; };
show();
W.timer = setInterval(() => { if (!document.body.contains(root)) return clearInterval(W.timer); if (!W.pinned) { W.i++; show(); } }, ROTACAO_MS);

/* --- card de detalhe (hover) --- */
function spark(arr, color) {
  if (!arr || arr.length < 2) return `<div class="nk-spark nk-empty">sem histórico</div>`;
  const w = 150, h = 28, mx = 100, step = w / (arr.length - 1);
  const pts = arr.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / mx) * h).toFixed(1)}`).join(" ");
  return `<svg class="nk-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="0,${h} ${pts} ${w},${h}" fill="${color}" fill-opacity=".15" stroke="none"/><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
}
const row = (k, v) => `<div class="nk-row"><span>${k}</span><span>${v}</span></div>`;
function detail(s) {
  const st = state(s), off = !online(s), x = s.x;
  const col = { down: "#ef4444", crit: "#fb923c", warn: "#f5b301", ok: "#22c55e", maint: "#6b7280" }[st];
  const used = x.memUsed != null ? x.memUsed : (x.memTotal != null && x.memAvail != null ? x.memTotal - x.memAvail : null);
  const pr = P.filter(p => p.h === s.n).sort((a, b) => b.sev - a.sev);
  const disks = Object.entries(s.disks).sort((a, b) => (b[1] || 0) - (a[1] || 0));
  return `<div class="nk-head" style="border-color:${col}"><div><b>${esc(s.n)}</b><div class="nk-sub">${esc(s.os || "—")} · ${stLabel(s).replace("● ", "agente ")}</div></div>
      <span class="badge" style="background:${col}">${st === "maint" ? "MANUTENÇÃO" : st === "ok" ? "OK" : s.st === 0 ? "OFFLINE" : "ALERTA"}</span></div>
    ${s.fw && s.cpu == null && s.mem == null ? `<div class="nk-sec"><div class="nk-t">Recursos</div><div class="nk-empty">CPU e memória não coletados (o template pfSense não traz; ver documentação do painel)</div></div>` : ""}
    <div class="nk-sec" style="${s.fw && s.cpu == null && s.mem == null ? "display:none" : ""}"><div class="nk-t">Recursos · última hora</div>
      <div class="nk-res"><div><span>CPU</span><b class="${lvl(s.cpu)}">${off ? "—" : pct(s.cpu)}</b></div>${spark(off ? [] : s.cpuH, "#38bdf8")}</div>
      <div class="nk-res"><div><span>Memória</span><b class="${lvl(s.mem)}">${off ? "—" : pct(s.mem)}</b></div>${spark(off ? [] : s.memH, "#a78bfa")}</div>
      ${s.fw && used == null && x.memTotal == null ? "" : row("Memória usada", used != null || x.memTotal != null ? `${bytes(used)} / ${bytes(x.memTotal)}` : "—")}
      ${x.swapFree != null ? row("Swap livre", pct(x.swapFree)) : ""}
    </div>
    <div class="nk-sec"><div class="nk-t">Sistema</div>
      ${ipOf(s.n) ? row("Endereço IP", esc(ipOf(s.n))) : ""}${row("Uptime", off ? "—" : dur(s.up))}
      ${s.fw && x.cores == null ? "" : row("Núcleos de CPU", x.cores != null ? x.cores : "—")}
      ${x.queue != null ? row("Fila de CPU", x.queue.toFixed(1)) : ""}${x.load != null ? row("Load (1m)", x.load.toFixed(2)) : ""}
      ${s.fw && x.procs == null ? "" : row("Processos", x.procs != null ? x.procs : "—")}
      ${row("Rede ↓ / ↑", off ? "—" : `${bps(s.rx)} / ${bps(s.tx)}`)}
    </div>
    ${s.fw ? `<div class="nk-sec"><div class="nk-t">Firewall</div>
      ${row("Conexões (estados)", `${num(x.states)} / ${num(x.statesMax)}`)}
      ${row("Uso da tabela de estados", pct(statesPct(s)))}
      ${x.srcTrack != null ? row("Source tracking", num(x.srcTrack)) : ""}
      ${row("Regras de firewall", num(x.rules))}
      ${row("Filtro PF", x.pf === 1 ? "rodando" : x.pf == null ? "—" : "PARADO")}
    </div>
    <div class="nk-sec"><div class="nk-t">Interfaces</div>
      ${Object.keys(s.ifs).length ? Object.entries(s.ifs).filter(([n]) => !/^(lo|pflog|pfsync|enc)\d/i.test(n)).sort((a, b) => ((b[1].rx || 0) + (b[1].tx || 0)) - ((a[1].rx || 0) + (a[1].tx || 0))).map(([n, I]) =>
        `<div class="nk-if"><span class="d ${I.st === 1 ? "up" : I.st == null ? "" : "dn"}"></span><span title="${esc(n)}">${esc(n)}</span><span>↓ ${bps(I.rx)}</span><span>↑ ${bps(I.tx)}</span></div>`).join("") : `<div class="nk-empty">sem dados</div>`}
    </div>` : ""}
    ${s.fw && !Object.keys(s.disks).length ? "" : `<div class="nk-sec"><div class="nk-t">Discos</div>
      ${disks.length ? disks.map(([k, v]) => `<div class="nk-disk"><span title="${esc(k)}">${esc(k)}</span><div class="track"><div class="fill ${lvl(v)}" style="width:${v || 0}%"></div></div><span>${pct(v)}</span></div>`).join("") : `<div class="nk-empty">sem dados</div>`}
    </div>`}
    <div class="nk-sec"><div class="nk-t">Problemas ativos (${pr.length})</div>
      ${pr.length ? pr.map(p => `<div class="nk-pr"><span class="sev" style="color:${SEVC[p.sev] || SEVC[0]}">${SEV[p.sev] || ""}</span>${esc(p.p)}<span class="nk-age">${age(p.ts)}</span></div>`).join("") : `<div class="nk-empty">Nenhum</div>`}
    </div>`;
}
const stale = document.querySelector("body > .noc-tip"); if (stale) stale.remove();   // versão antiga
root.style.position = "relative";
let tip = root.querySelector(".nk-card");
if (!tip) { tip = document.createElement("div"); tip.className = "nk-card"; root.appendChild(tip); }
let tipFor = null;
root.onmousemove = e => {
  const c = e.target.closest(".card");
  if (!c) { tip.style.display = "none"; tipFor = null; return; }
  const s = S.find(x => x.n === c.dataset.n); if (!s) return;
  if (tipFor !== s.n) { tip.innerHTML = detail(s); tipFor = s.n; }
  tip.style.display = "block";
  posTip(tip, e, root, 18);
};
root.onmouseleave = () => { tip.style.display = "none"; tipFor = null; };
// duplo clique num card abre o dashboard de detalhe do servidor (só se DRILL_UID estiver definido no topo do código)
root.ondblclick = e => {
  const c = e.target.closest(".card, .q li[data-n]"); if (!c || typeof DRILL_UID === "undefined" || !DRILL_UID) return;
  const base = location.pathname.replace(/\/d\/.*$/, "");
  window.top.location.href = `${base}/d/${DRILL_UID}?var-host=${encodeURIComponent(c.dataset.n)}`;
};
root.onclick = e => {
  const t = e.target.closest(".q li[data-n], .card"); if (!t) return;
  W.pinned = W.pinned === t.dataset.n ? null : t.dataset.n;
  if (!W.pinned) { const k = rot.indexOf(t.dataset.n); if (k >= 0) W.i = k; }
  show();
};

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

