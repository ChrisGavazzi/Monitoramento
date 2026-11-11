/* Detalhe do Servidor - mesmo código de leitura do NOC (noc.js), com um layout de um host só. */
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
const series0 = findSeries(ctx, 0, new Set())
  || (typeof panelData !== "undefined" ? findSeries(panelData, 0, new Set()) : null)
  || (typeof data !== "undefined" ? findSeries(data, 0, new Set()) : null) || [];
const ZS = series0.filter(f => f.refId === "Z" || f.refId === "Y"), series = series0.filter(f => f.refId !== "Z" && f.refId !== "Y");
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
  root.innerHTML = `<div class="dbg">Detalhe: nenhum dado para este servidor nas queries.\nTire um print desta caixa e envie.\n\n${esc(debug.join("\n") || "Nenhum dado recebido (confira as queries e o datasource).")}\n\n${esc(ctxInfo)}</div>`;
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
      ${row("Uptime", off ? "—" : dur(s.up))}
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

/* --- detalhe de UM servidor (variável $host) --- */
const s = S[0];
const st = state(s), off = !online(s), x = s.x;
const col = { down: "#ef4444", crit: "#fb923c", warn: "#f5b301", ok: "#22c55e", maint: "#6b7280" }[st];
const badge = st === "maint" ? "MANUTENÇÃO" : st === "ok" ? "OK" : s.st === 0 ? "OFFLINE" : "ALERTA";
const used = x.memUsed != null ? x.memUsed : (x.memTotal != null && x.memAvail != null ? x.memTotal - x.memAvail : null);
const pr = P.filter(p => p.h === s.n).sort((a, b) => (a.mt - b.mt) || b.sev - a.sev || b.ts - a.ts);
const prA = pr.filter(p => !p.mt);
const disks = Object.entries(s.disks).sort((a, b) => (b[1] || 0) - (a[1] || 0));
const IFSKIP = /^(lo|pflog|pfsync|enc)\d|loopback|isatap|teredo|pseudo|wfp|qos packet|kernel debug|6to4|ip-https/i;
const ifs = Object.entries(s.ifs).filter(([n]) => !IFSKIP.test(n))
  .sort((a, b) => ((b[1].rx || 0) + (b[1].tx || 0)) - ((a[1].rx || 0) + (a[1].tx || 0)));
// nome curto da interface: "Intel(R) 82574L ...(Ethernet0)" -> "Ethernet0"; "em0(WAN)" -> "em0 · WAN"
const ifLabel = n => { const m = n.match(/^(.*?)\s*\(([^()]+)\)$/); if (!m || !m[2].trim()) return n; return m[1].length && m[1].length <= 10 ? `${m[1]} · ${m[2]}` : m[2]; };
const chip = (l, v, cls) => `<div class="dd-chip ${cls || ""}"><span>${l}</span><b>${v}</b></div>`;
const semRecursos = s.fw && s.cpu == null && s.mem == null;

const recursos = semRecursos ? `<div class="nk-empty">CPU e memória não coletados por este template.</div>` : `
  <div class="nk-res"><div><span>CPU</span><b class="${lvl(s.cpu)}">${off ? "—" : pct(s.cpu)}</b></div>${spark(off ? [] : s.cpuH, "#38bdf8")}</div>
  <div class="nk-res"><div><span>Memória</span><b class="${lvl(s.mem)}">${off ? "—" : pct(s.mem)}</b></div>${spark(off ? [] : s.memH, "#a78bfa")}</div>
  ${used != null || x.memTotal != null ? row("Memória usada", `${bytes(used)} / ${bytes(x.memTotal)}`) : ""}
  ${x.swapFree != null ? row("Swap livre", pct(x.swapFree)) : ""}`;

const sistema = `
  ${row("Uptime", off ? "—" : dur(s.up))}
  ${x.cores != null ? row("Núcleos de CPU", x.cores) : ""}
  ${x.queue != null ? row("Fila de CPU", x.queue.toFixed(1)) : ""}${x.load != null ? row("Load (1m)", x.load.toFixed(2)) : ""}
  ${x.procs != null ? row("Processos", x.procs) : ""}
  ${row("Agente", stLabel(s).replace("● ", ""))}`;

const discos = disks.length
  ? disks.map(([k, v]) => `<div class="nk-disk"><span title="${esc(k)}">${esc(k)}</span><div class="track"><div class="fill ${lvl(v)}" style="width:${v || 0}%"></div></div><span>${pct(v)}</span></div>`).join("")
  : `<div class="nk-empty">sem dados de disco</div>`;

const rede = `${row("Total ↓ / ↑", off ? "—" : `${bps(s.rx)} / ${bps(s.tx)}`)}
  ${ifs.length ? ifs.slice(0, 8).map(([n, I]) => `<div class="nk-if"><span class="d ${I.st === 1 ? "up" : I.st == null ? "" : "dn"}"></span><span title="${esc(n)}">${esc(ifLabel(n))}</span><span>↓ ${bps(I.rx)}</span><span>↑ ${bps(I.tx)}</span></div>`).join("")
    + (ifs.length > 8 ? `<div class="nk-empty">+${ifs.length - 8} interface(s) — ver gráfico de rede abaixo</div>` : "") : ""}`;

const firewall = !s.fw ? "" : `<div class="dd-box"><div class="nk-t">Firewall</div>
  ${row("Conexões (estados)", `${num(x.states)} / ${num(x.statesMax)}`)}
  ${bar("ESTADOS", statesPct(s), off, "Uso da tabela de estados")}
  ${x.srcTrack != null ? row("Source tracking", num(x.srcTrack)) : ""}
  ${row("Regras de firewall", num(x.rules))}
  ${row("Filtro PF", x.pf === 1 ? "rodando" : x.pf == null ? "—" : "PARADO")}</div>`;

const probs = pr.length
  ? pr.map(p => `<div class="nk-pr ${p.mt ? "mt" : ""}"><span class="sev" style="color:${p.mt ? "#6b7280" : SEVC[p.sev] || SEVC[0]}">${SEV[p.sev] || ""}</span>${esc(p.p)}<span class="nk-age">${age(p.ts)}</span></div>`).join("")
  : `<div class="dd-ok">Nenhum problema ativo</div>`;

const topD = disks.length ? disks[0] : null;
/* --- seletor: um botão por servidor (query Z = disponibilidade de todos) --- */
const ZH = {};
for (const fr of ZS) if (fr.refId === "Z") for (const f of fr.fields || []) {
  if (f.type !== "number") continue;
  const nm = seriesName(fr, f), h = hostOf(fr, f, nm), v = lastNN(vals(f));
  if (!h) continue;
  ZH[h] = (ZH[h] == null || v === 0) ? v : ZH[h];        // vale o pior (ping 0 ou agente 0)
}
// Y = problemas de todos os hosts: botão amarelo/laranja quando o host está online com problema
const ZP = {};
for (const fr of ZS) if (fr.refId === "Y") for (const f of fr.fields || []) {
  const v = vals(f); if (!v.length || typeof v[0] !== "object" || v[0] === null) continue;
  v.forEach(p => { const hs = p.hosts && p.hosts[0], h = (hs && (hs.name || hs.host)) || p.host; if (!h) return;
    if (p.suppressed == 1 || p.suppressed === "1" || (hs && hs.maintenance_status == 1)) return;
    const sv = Number(p.severity != null ? p.severity : p.priority) || 0; ZP[h] = Math.max(ZP[h] == null ? -1 : ZP[h], sv); });
}
const selCls = n => ZH[n] === 0 ? "off" : ZP[n] != null ? (ZP[n] >= 4 ? "hi" : "al") : ZH[n] === 1 ? "on" : "unk";
const selHtml = Object.keys(ZH).length > 1 ? `<div class="dd-sel">${Object.keys(ZH).sort((a, b) => a.localeCompare(b)).map(n =>
  `<button class="dd-s ${selCls(n)} ${n === s.n ? "cur" : ""}" data-h="${esc(n)}" title="${esc(n)}"><i></i>${esc(n)}</button>`).join("")}</div>` : "";
root.innerHTML = `<div class="dd">
  ${selHtml}
  <div class="dd-head" style="border-color:${col}">
    <div class="dd-id"><b>${esc(s.n)}</b><div class="nk-sub">${esc(s.os || "—")} · agente ${stLabel(s).replace("● ", "")} · uptime ${off ? "—" : dur(s.up)}${S.length > 1 ? ` · <em>${S.length} hosts selecionados: mostrando o primeiro</em>` : ""}</div></div>
    <div class="dd-chips">
      ${semRecursos ? "" : chip("CPU", off ? "—" : pct(s.cpu), lvl(s.cpu))}
      ${semRecursos ? "" : chip("Memória", off ? "—" : pct(s.mem), lvl(s.mem))}
      ${s.fw ? chip("Conexões", off ? "—" : num(x.states), lvl(statesPct(s))) : ""}
      ${topD ? chip("Disco " + esc(shortDisk(topD[0])), pct(topD[1]), lvl(topD[1])) : ""}
      ${chip("Rede ↓/↑", off ? "—" : `${bps(s.rx)} / ${bps(s.tx)}`)}
      ${chip("Problemas", prA.length, prA.some(p => p.sev >= 4) ? "o" : prA.length ? "w" : "")}
    </div>
    <span class="badge" style="background:${col}">${badge}</span>
  </div>
  <div class="dd-grid">
    ${semRecursos ? "" : `<div class="dd-box"><div class="nk-t">Recursos · última hora</div>${recursos}</div>`}
    <div class="dd-box"><div class="nk-t">Sistema</div>${sistema}</div>
    <div class="dd-box"><div class="nk-t">Discos (${disks.length})</div>${discos}</div>
    <div class="dd-box"><div class="nk-t">Rede</div>${rede}</div>
    ${firewall}
    <div class="dd-box dd-pr"><div class="nk-t">Problemas ativos (${prA.length})${pr.length > prA.length ? ` · ${pr.length - prA.length} em manutenção` : ""}</div>${probs}</div>
  </div>
</div>`;

root.onclick = e => {
  const b = e.target.closest(".dd-s"); if (!b || b.classList.contains("cur")) return;
  const n = b.dataset.h, ls = ctx.grafana && ctx.grafana.locationService;
  if (ls && typeof ls.partial === "function") ls.partial({ "var-host": n }, true);
  else { const u = new URL(window.top.location.href); u.searchParams.set("var-host", n); window.top.location.href = u.toString(); }
};

