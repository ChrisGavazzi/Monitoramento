/* NOC Evento - LINKS DE INTERNET (Business Text, afterRender)
 * Queries: R = interfaces dos roteadores de borda (status, tráfego, velocidade, erros)
 *          S = sistema dos roteadores (CPU, memória, temperatura, uptime)
 *          L = ping do gateway de cada operadora (hosts LINK-<NOME>, template "NOC - Link WAN")
 *          F = problemas
 *
 * Abaixo dos links: todas as outras interfaces do roteador, agrupadas em VPNs/túneis, físicas, VLANs e outras.
 *
 * Como um link aparece aqui (escolha UMA forma):
 *  1) Comentário da interface no MikroTik:  WAN-<NOME> <down>/<up>   ex.:  WAN-BETA 500/250   (Mbps contratados)
 *     /interface set sfp-sfpplus1 comment="WAN-BETA 500/250"
 *     O Zabbix lê o comentário como descrição da interface (ifAlias) na próxima descoberta (até 1h).
 *  2) Nome da interface com WAN (ex.: ether1-Link_WAN_MyLaps) — sem banda contratada
 *  3) Lista LINKS abaixo (tem prioridade sobre o comentário).
 * O ping do gateway é casado pelo nome: host LINK-BETA <-> link BETA.
 */
const LINKS = NOC.links || [];   // links do site, do noc.yaml: { roteador, iface, nome, down, up, gw }
const UTIL_ATENCAO = 70, UTIL_CRITICO = 90;            // % do contratado
const PERDA_ATENCAO = 5, LAT_ATENCAO = 80, JIT_ATENCAO = 30;   // %, ms, ms

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
const norm = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/* --- leitura --- */
const RT = {}, GW = {}, debug = [];
let problems = [], newest = 0;
const rt = h => (RT[h] = RT[h] || { n: h, ifs: {}, cpu: null, mem: null, temp: [], up: null, dhcp: {}, inet: {}, inetH: {} });
const gw = h => (GW[h] = GW[h] || { n: h, ping: null, loss: null, rtt: null, jit: null, rttH: [], lossH: [], pingH: [] });
for (const fr of series) {
  const ref = fr.refId || "";
  const tf = (fr.fields || []).find(f => f.type === "time");
  if (tf && ref !== "F") { const t = lastNN(vals(tf)); if (t > newest) newest = t; }
  for (const f of fr.fields || []) {
    const v = vals(f);
    debug.push(`[${ref}] ${sName(fr, f)} type=${f.type} n=${v.length}`);
    if (ref === "F") { if (v.length && typeof v[0] === "object" && v[0] !== null) problems = problems.concat(v); continue; }
    if (f.type !== "number") continue;
    const nm = sName(fr, f), h = hostOf(f, nm), it = itemOf(f, nm), x = lastNN(v), hist = v.filter(n => n != null);
    if (!h) continue;
    if (ref === "R") {
      const m = it.match(/^Interface\s+(.+?)\((.*)\):\s*(.+)$/) || it.match(/^Interface\s+(\S+):\s*(.+)$/);
      if (!m) continue;
      const pn = m[1], alias = m.length === 4 ? m[2] : "", met = m.length === 4 ? m[3] : m[2];
      const s = rt(h), p = s.ifs[pn] = s.ifs[pn] || { n: pn, alias, st: null, rx: null, tx: null, sp: null, ein: null, eout: null, rxH: [], txH: [], stH: [], type: null };
      if (/Operational status/i.test(met)) { p.st = x; p.stH = hist; }
      else if (/Bits received/i.test(met)) { p.rx = x; p.rxH = hist.slice(-120); }
      else if (/Bits sent/i.test(met)) { p.tx = x; p.txH = hist.slice(-120); }
      else if (/Speed/i.test(met)) p.sp = x;
      else if (/Inbound packets with errors/i.test(met)) p.ein = x;
      else if (/Outbound packets with errors/i.test(met)) p.eout = x;
      else if (/Interface type/i.test(met)) p.type = x;
    } else if (ref === "S") {
      const s = rt(h);
      const dh = it.match(/^WAN\s+(.+?):\s*DHCP client com IP/i);
      if (dh) { const k = /\{\$/.test(dh[1]) ? "?" : norm(dh[1]); s.dhcp[k] = x; (s.dhcpH = s.dhcpH || {})[k] = hist; continue; }
      // "WAN BETA: internet" = sentinela do roteador (Netwatch pinga a sonda pelo link e liga/desliga um IP que o Zabbix pinga)
      const ni = it.match(/^WAN\s+(.+?):\s*internet\b/i);
      if (ni && !/\{\$/.test(ni[1])) { const k = norm(ni[1]); s.inet[k] = x; s.inetH[k] = hist; continue; }
      if (/CPU utilization/i.test(it)) s.cpu = s.cpu == null ? x : Math.max(s.cpu, x);
      else if (/Memory utilization/i.test(it)) s.mem = s.mem == null ? x : Math.max(s.mem, x);
      else if (/Temperature/i.test(it)) s.temp.push(x);
      else if (/Uptime/i.test(it)) s.up = s.up == null ? x : Math.max(s.up, x);
    } else if (ref === "L") {
      const g = gw(h);
      if (/ICMP: disponível/i.test(it)) { g.ping = x; g.pingH = hist; }
      else if (/ICMP: perda/i.test(it)) { g.loss = x; g.lossH = hist; }
      else if (/ICMP: tempo de resposta/i.test(it)) { g.rtt = x; g.rttH = hist.slice(-120); }
      else if (/ICMP: variação/i.test(it)) g.jit = x;
    }
  }
}
const P = problems.map(p => { const hs = p.hosts && p.hosts[0]; let ts = Number(p.lastchange || p.timestamp || 0); if (ts > 1e12) ts /= 1000;
  return { h: (hs && (hs.name || hs.host)) || p.host || "?", p: p.name || p.description || "", sev: Number(p.severity != null ? p.severity : p.priority) || 0, ts }; });

if (!Object.keys(RT).length && !Object.keys(GW).length) {
  root.innerHTML = `<div class="dbg">Links: nenhum dado.\nConfira se os roteadores estão no grupo "Rede/Roteadores" (links: "Rede/Links") com o template SNMP do MikroTik e se a descoberta de interfaces já rodou.\n\n${esc(debug.slice(0, 80).join("\n") || "Nenhum dado recebido.")}</div>`;
  return;
}

/* --- quais interfaces são links --- */
const WANRX = /^\s*(WAN|LINK|ISP)[\s_\-:]*([^\d\s][^\s]*)?\s*(?:(\d+(?:[.,]\d+)?)\s*([MG])?\s*\/\s*(\d+(?:[.,]\d+)?)\s*([MG])?)?/i;
const mbps = (n, u) => n == null ? null : parseFloat(String(n).replace(",", ".")) * (/g/i.test(u || "") ? 1000 : 1);
const PHYS = /^(ether|sfp|qsfp|combo|eth|ge|xe|gi|te)/i;
const WANNAME = /(^|[^a-z])WAN(?![a-z])/i;
// VPN pelo nome (MikroTik: wireguard, l2tp, sstp, ovpn, pptp, gre, eoip, ipip, vxlan; dinâmicas aparecem como <l2tp-user>)
const VPNRX = /^<|(^|[^a-z])(wg|wireguard|l2tp|pptp|sstp|ovpn|openvpn|gre|ipip|eoip|6to4|vxlan|ipsec|vpn|tunnel|tun)(?![a-z])/i;
const VLANRX = /(^|[^a-z])vlan/i;
function kind(p) {
  const t = `${p.n} ${p.alias || ""}`;
  if (VPNRX.test(t) || p.type === 131 || p.type === 23) return "vpn";
  if (VLANRX.test(p.n) || p.type === 135) return "vlan";
  if (/^(ether|sfp|qsfp|combo)/i.test(p.n)) return "phys";
  return "outra";
}
const gwFor = nome => {
  const k = norm(nome); if (!k) return null;
  return Object.values(GW).find(g => norm(g.n) === "LINK" + k) || Object.values(GW).find(g => norm(g.n).includes(k)) || null;
};
const links = [], usedGW = new Set();
const add = (r, p, o) => { const g = o.gw ? GW[o.gw] : gwFor(o.nome); if (g) usedGW.add(g.n); links.push(Object.assign({ r, p, g }, o)); };
if (LINKS.length) {
  LINKS.forEach(l => { const r = RT[l.roteador]; add(r || { n: l.roteador, ifs: {} }, r && r.ifs[l.iface], { nome: l.nome, down: l.down, up: l.up, gw: l.gw, iface: l.iface }); });
} else {
  Object.values(RT).forEach(r => Object.values(r.ifs).forEach(p => {
    const m = (p.alias || "").match(WANRX);
    if (m && /^(WAN|LINK|ISP)/i.test(p.alias.trim())) {
      add(r, p, { nome: (m[2] || p.n).replace(/^[\s_\-]+/, ""), down: mbps(m[3], m[4]), up: mbps(m[5], m[6] || m[4]), iface: p.n });
    } else if (WANNAME.test(p.n) && !VPNRX.test(p.n)) {
      // interface renomeada com WAN no nome (ex.: ether1-Link_WAN_MyLaps): link sem banda contratada declarada
      const nome = p.n.replace(/^(ether|sfp-sfpplus|sfp|qsfp|combo)\d+[\s_\-]*/i, "").replace(/(^|[_\-\s])(link|wan)(?=$|[_\-\s])/ig, " ").replace(/[\s_\-]+/g, "-").replace(/^-+|-+$/g, "") || p.n;
      add(r, p, { nome, down: null, up: null, iface: p.n });
    }
  }));
}
{
  const keep = {};
  links.forEach((l, i) => { const k = (l.r ? l.r.n : "") + "|" + norm(l.nome); const o = keep[k];
    const score = x => (x.p && !PHYS.test(x.p.n) ? 1e15 : 0) + (x.p ? (x.p.rx || 0) + (x.p.tx || 0) : 0);
    if (!o || score(l) > score(links[o.i])) keep[k] = { i }; });
  const ok = new Set(Object.values(keep).map(o => o.i));
  for (let i = links.length - 1; i >= 0; i--) if (!ok.has(i)) links.splice(i, 1);
}
// gateways sem interface casada continuam aparecendo (ping ok, sem tráfego)
Object.values(GW).filter(g => !usedGW.has(g.n)).forEach(g => links.push({ r: null, p: null, g, nome: g.n.replace(/^LINK[\s_\-]*/i, ""), iface: null }));

/* --- cálculo --- */
const ms = s => s == null ? null : s * 1000;
function jitter(g) {
  if (!g) return null; if (g.jit != null) return ms(g.jit);
  const a = g.rttH.slice(-20); if (a.length < 4) return null;   // aproximação: variação média entre coletas
  let s = 0; for (let i = 1; i < a.length; i++) s += Math.abs(a[i] - a[i - 1]); return ms(s / (a.length - 1));
}
function calc(l) {
  const p = l.p, g = l.g;
  const capD = l.down ? l.down * 1e6 : (p && p.sp) || null, capU = l.up ? l.up * 1e6 : (p && p.sp) || null;
  const uD = p && capD ? (p.rx || 0) / capD * 100 : null, uU = p && capU ? (p.tx || 0) / capU * 100 : null;
  // link por DHCP client (sem ping da nuvem). Nome com macro não resolvida ("?"): vale para o link do roteador que não tem ping
  const dk = l.r && l.r.dhcp ? (norm(l.nome) in l.r.dhcp ? norm(l.nome) : (!g && "?" in l.r.dhcp ? "?" : null)) : null;
  const dh = dk ? l.r.dhcp[dk] : undefined; l.dk = dk;
  const ni = l.r && l.r.inet && norm(l.nome) in l.r.inet ? l.r.inet[norm(l.nome)] : undefined;
  const ifDown = p && p.st != null && p.st !== 1, gwDown = g && g.ping === 0, dhcpDown = dh === 0 && ni === undefined, inetDown = ni === 0;
  l.dhcp = dh; l.inet = ni;
  const lat = g && !gwDown ? ms(g.rtt) : null, loss = g ? g.loss : null, jit = g && !gwDown ? jitter(g) : null;
  const um = Math.max(uD || 0, uU || 0);
  const why = [];
  if (ifDown) why.push("interface down"); if (gwDown) why.push("gateway sem resposta"); if (dhcpDown && !ifDown) why.push("sem IP no DHCP client");
  if (inetDown && !ifDown && !gwDown) why.push("SEM INTERNET (teste do roteador pelo link)");
  if (loss != null && loss >= PERDA_ATENCAO && !gwDown) why.push(`perda ${Math.round(loss)}%`);
  if (lat != null && lat >= LAT_ATENCAO) why.push(`latência ${Math.round(lat)} ms`);
  if (jit != null && jit >= JIT_ATENCAO) why.push(`jitter ${Math.round(jit)} ms`);
  if (um >= UTIL_CRITICO) why.push(`uso ${Math.round(um)}% do contratado`); else if (um >= UTIL_ATENCAO) why.push(`uso ${Math.round(um)}%`);
  if (p && (p.ein || 0) + (p.eout || 0) > 0) why.push("erros na interface");
  const st = (ifDown || gwDown || dhcpDown || inetDown) ? "crit" : why.length ? (um >= UTIL_CRITICO ? "crit" : "warn") : (!p && !g) ? "unk" : "ok";
  const semTeste = !g && dh === undefined && ni === undefined;
  if (semTeste && p && !ifDown) why.push("sem teste de internet: só o estado da porta");
  const st2 = st === "ok" && semTeste && p ? "warn" : st;
  const peak = p ? Math.max(0, ...p.rxH) : null;
  const dhH = l.r && l.r.dhcpH && l.dk ? l.r.dhcpH[l.dk] : null;
  const inH = l.r && l.r.inetH ? l.r.inetH[norm(l.nome)] : null;
  const avail = inH && inH.length ? inH.filter(x => x === 1).length / inH.length * 100 : !g && dhH && dhH.length ? dhH.filter(x => x === 1).length / dhH.length * 100 : g && g.pingH.length ? g.pingH.filter(x => x === 1).length / g.pingH.length * 100 : (p && p.stH.length ? p.stH.filter(x => x === 1).length / p.stH.length * 100 : null);
  return Object.assign(l, { capD, capU, uD, uU, lat, loss, jit, st: st2, why, peak, avail, ifDown, gwDown, dhcpDown, inetDown });
}
links.forEach(calc);

/* --- formatação --- */
const bps = b => { if (b == null) return "—"; const u = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"]; let i = 0; while (b >= 1000 && i < 4) { b /= 1000; i++; } return (i && b < 100 ? b.toFixed(1) : b.toFixed(0)) + " " + u[i]; };
const cap = b => !b ? "?" : b >= 1e9 ? (b / 1e9).toFixed(b % 1e9 ? 1 : 0) + "G" : Math.round(b / 1e6) + "M";
const dur = x => { if (x == null) return "—"; x = Math.floor(x); const d = Math.floor(x / 86400), h = Math.floor(x % 86400 / 3600); return d ? `${d}d ${h}h` : `${h}h ${Math.floor(x % 3600 / 60)}m`; };
const age = ts => { if (!ts) return ""; let x = Math.floor(Date.now() / 1000 - ts); const d = Math.floor(x / 86400), h = Math.floor(x % 86400 / 3600), m = Math.floor(x % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
const SEV = ["N/C", "Info", "Warning", "Average", "High", "Disaster"], SEVC = ["#6b7280", "#38bdf8", "#f5b301", "#fb923c", "#ef4444", "#b91c1c"];
const lvl = (v, w, c) => v == null ? "" : v >= c ? "crit" : v >= w ? "warn" : "";
const bar = (cur, capv, u, lab, cls) => `<div class="lk-dir"><div class="lk-dl"><span>${lab}</span><b>${bps(cur)}</b><span class="of">/ ${cap(capv)}</span><span class="pc ${lvl(u, UTIL_ATENCAO, UTIL_CRITICO)}">${u == null ? "" : Math.round(u) + "%"}</span></div>
  <div class="lk-bar"><div class="lk-fill ${cls} ${lvl(u, UTIL_ATENCAO, UTIL_CRITICO)}" style="width:${Math.min(u || 0, 100).toFixed(1)}%"></div><i style="left:${UTIL_ATENCAO}%"></i><i style="left:${UTIL_CRITICO}%"></i></div></div>`;
function spark(l) {
  const p = l.p; if (!p || (p.rxH.length + p.txH.length) < 4) return `<div class="lk-nospark">sem histórico de tráfego</div>`;
  const w = 400, h = 56, mx = Math.max(l.capD || 0, ...p.rxH, ...p.txH, 1) * 1.05;
  const pts = s => { const st = w / Math.max(s.length - 1, 1); return s.map((v, i) => `${(i * st).toFixed(1)},${(h - v / mx * h).toFixed(1)}`).join(" "); };
  const area = s => s.length ? `<polygon points="0,${h} ${pts(s)} ${w},${h}" fill="rgba(56,189,248,.14)"/>` : "";
  const capLine = l.down ? `<line x1="0" x2="${w}" y1="${(h - l.capD / mx * h).toFixed(1)}" y2="${(h - l.capD / mx * h).toFixed(1)}" stroke="#64748b" stroke-dasharray="4 3" stroke-width="1"/>` : "";
  return `<svg class="lk-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${capLine}${area(p.rxH)}<polyline points="${pts(p.rxH)}" fill="none" stroke="#38bdf8" stroke-width="1.6"/><polyline points="${pts(p.txH)}" fill="none" stroke="#a78bfa" stroke-width="1.3"/></svg>`;
}
const ST = { 1: "up", 2: "down", 3: "testing", 4: "unknown", 5: "dormant", 6: "notPresent", 7: "lowerLayerDown" };
const met = (k, v, cls, sub) => `<div class="lk-m ${cls || ""}"><span>${k}</span><b>${v}</b>${sub ? `<em>${sub}</em>` : ""}</div>`;
const BADGE = { ok: "ONLINE", warn: "DEGRADADO", crit: "FORA", unk: "SEM DADOS" };
/* modo compacto (embutido em outra tela): defina "const LK_COMPACTO = true;" e, opcional, "const LK_DETALHE = '<uid>';" antes deste código */
const COMPACTO = typeof LK_COMPACTO !== "undefined" && !!LK_COMPACTO;
const DETALHE = typeof LK_DETALHE !== "undefined" ? LK_DETALHE : null;
function cardC(l) {
  const p = l.p, g = l.g;
  const info = [g ? `latência <b>${l.lat == null ? "—" : l.lat.toFixed(l.lat < 10 ? 1 : 0) + " ms"}</b>` : null, g ? `perda <b>${l.loss == null ? "—" : Math.round(l.loss) + "%"}</b>` : null,
                l.inet != null ? `internet <b class="${l.inet === 1 ? "" : "bad"}">${l.inet === 1 ? "ok" : "SEM"}</b>` : null,
                `disponível 1h <b class="${l.avail != null && l.avail < 99 ? "bad" : ""}">${l.avail == null ? "—" : (l.avail >= 99.95 ? "100" : l.avail.toFixed(1)) + "%"}</b>`].filter(Boolean);
  return `<div class="lk lk-c ${l.st}"${p && l.r ? ` data-r="${esc(l.r.n)}" data-i="${esc(p.n)}"` : ""}>
    <div class="lk-h"><div><b>${esc(l.nome)}</b><span class="lk-sub"> ${esc(l.iface || "")}</span></div><span class="lk-badge">${BADGE[l.st]}</span></div>
    ${l.why.length ? `<div class="lk-why">${l.why.map(esc).join(" · ")}</div>` : ""}
    ${p ? bar(p.rx, l.capD, l.uD, "↓", "dn") + bar(p.tx, l.capU, l.uU, "↑", "upl") : ""}
    <div class="lk-ci">${info.join(" · ")}</div></div>`;
}
function card(l) {
  if (COMPACTO) return cardC(l);
  const p = l.p, g = l.g;
  const sub = [l.r ? l.r.n : null, l.iface || null, p && p.alias && !/^(WAN|LINK|ISP)/i.test(p.alias) ? p.alias : null].filter(Boolean).join(" · ");
  const hint = !g && l.inet != null ? `<div class="lk-hint">internet testada pelo roteador por este link (sonda pública via Netwatch): ${l.inet === 1 ? "com internet" : "<b>SEM INTERNET</b>"} · disponível = % do tempo com internet</div>`
             : !g && l.dhcp != null ? `<div class="lk-hint">link por DHCP client, sem ping da nuvem: estado = IP recebido da operadora (${l.dhcp === 1 ? "com IP" : "<b>sem IP</b>"})</div>`
             : !g ? `<div class="lk-hint">sem ping do gateway: cadastre o host <b>LINK-${esc(norm(l.nome))}</b> (IP do gateway da operadora) com o template "NOC - Link WAN"</div>`
             : !p ? `<div class="lk-hint">ping ok, mas sem interface casada: comente a interface no MikroTik como <b>WAN-${esc(norm(l.nome))} &lt;down&gt;/&lt;up&gt;</b></div>`
             : !l.down ? `<div class="lk-hint">banda contratada desconhecida: % calculado sobre a velocidade da porta. Use o comentário <b>WAN-${esc(norm(l.nome))} 500/250</b></div>` : "";
  return `<div class="lk ${l.st}"${l.p && l.r ? ` data-r="${esc(l.r.n)}" data-i="${esc(l.p.n)}"` : ""}>
    <div class="lk-h"><div><b>${esc(l.nome)}</b><div class="lk-sub">${esc(sub) || "&nbsp;"}</div></div><span class="lk-badge">${BADGE[l.st]}</span></div>
    ${l.why.length ? `<div class="lk-why">${l.why.map(esc).join(" · ")}</div>` : ""}
    ${p ? bar(p.rx, l.capD, l.uD, "↓ download", "dn") + bar(p.tx, l.capU, l.uU, "↑ upload", "upl") : ""}
    ${spark(l)}
    <div class="lk-ms">
      ${met("latência", l.lat == null ? "—" : l.lat.toFixed(l.lat < 10 ? 1 : 0) + " ms", lvl(l.lat, LAT_ATENCAO, LAT_ATENCAO * 2), "gateway")}
      ${met("perda", l.loss == null ? "—" : Math.round(l.loss) + "%", lvl(l.loss, PERDA_ATENCAO, 20))}
      ${met("jitter", l.jit == null ? "—" : l.jit.toFixed(l.jit < 10 ? 1 : 0) + " ms", lvl(l.jit, JIT_ATENCAO, JIT_ATENCAO * 2), g && g.jit != null ? "desvio 5m" : "aprox.")}
      ${met("pico ↓ 1h", bps(l.peak).replace("bps", ""), "")}
      ${met("disponível", l.avail == null ? "—" : (l.avail >= 99.95 ? "100" : l.avail.toFixed(1)) + "%", l.avail != null && l.avail < 99 ? "warn" : "", "1h")}
    </div>${hint}
  </div>`;
}

/* --- por roteador --- */
const byR = {};
links.forEach(l => { const k = l.r ? l.r.n : "(gateways sem roteador)"; (byR[k] = byR[k] || []).push(l); });
Object.values(RT).forEach(r => { byR[r.n] = byR[r.n] || []; });
const KIND = [["vpn", "VPNs e túneis"], ["phys", "Portas físicas"], ["vlan", "VLANs"], ["outra", "Bridges, bonding e outras"]];
function itile(r, p) {
  const k = p.kind, act = (p.rx || 0) + (p.tx || 0) > 2000;
  const st = p.st === 1 ? ((p.ein || 0) + (p.eout || 0) > 0 ? "err" : act ? "busy" : (k === "vpn" ? "idle" : "up")) : p.st == null ? "unk" : (k === "phys" && !p.alias && !/[-_ ]/.test(p.n) ? "vazia" : "down");
  const nm = p.n.replace(/^<|>$/g, "");
  return `<div class="if ${st}" data-r="${esc(r.n)}" data-i="${esc(p.n)}"><div class="if-n"><i></i><b>${esc(nm)}</b></div>
    ${p.alias ? `<div class="if-a">${esc(p.alias)}</div>` : ""}
    <div class="if-t">${p.st === 1 ? `↓ ${bps(p.rx)} <span>↑ ${bps(p.tx)}</span>` : (ST[p.st] || "sem dados")}</div></div>`;
}
function ifaces(r, ls) {
  const used = new Set(ls.filter(l => l.p && !PHYS.test(l.p.n)).map(l => l.p.n));
  const all = Object.values(r.ifs).filter(p => !used.has(p.n)).map(p => Object.assign(p, { kind: kind(p) }));
  if (!all.length) return "";
  if (COMPACTO && typeof LK_IFCHIPS !== "undefined" && LK_IFCHIPS) {   // etiquetas mínimas (opcional); padrão = seções completas
    const kb = b => bps(b).replace(" Kbps", "K").replace(" Mbps", "M").replace(" Gbps", "G").replace(" bps", "");
    const ord = { vpn: 0, phys: 1, vlan: 2, outra: 3 };
    return `<div class="ifc"><span class="ifc-t">Interfaces</span>${all.sort((a, b) => ord[a.kind] - ord[b.kind] || a.n.localeCompare(b.n, undefined, { numeric: true })).map(p => {
      const st = p.st === 1 ? "up" : p.st == null ? "unk" : (p.kind === "phys" && !p.alias && !/[-_ ]/.test(p.n) ? "vazia" : "down");
      return `<span class="ifx ${st} ${p.kind}" data-r="${esc(r.n)}" data-i="${esc(p.n)}"><i></i>${esc(p.n.replace(/^<|>$/g, ""))}${p.st === 1 ? ` <em>↓${kb(p.rx)} ↑${kb(p.tx)}</em>` : ""}</span>`; }).join("")}</div>`;
  }
  return `<div class="ifs">${KIND.map(([k, t]) => {
    const ps = all.filter(p => p.kind === k).sort((a, b) => ((b.st === 1) - (a.st === 1)) || a.n.localeCompare(b.n, undefined, { numeric: true }));
    if (!ps.length) return "";
    const up = ps.filter(p => p.st === 1).length, dn = ps.filter(p => p.st != null && p.st !== 1).length;
    const rx = ps.reduce((a, p) => a + (p.rx || 0), 0), tx = ps.reduce((a, p) => a + (p.tx || 0), 0);
    return `<div class="ifg ${k}"><div class="ifg-h"><b>${t}</b><span>${up}/${ps.length} up</span>${k === "vpn" && dn ? `<span class="tag crit">${dn} down</span>` : ""}<span class="of">↓ ${bps(rx)} ↑ ${bps(tx)}</span>
      ${k === "vpn" ? `<span class="nota">WireGuard fica "up" mesmo sem o outro lado: veja o tráfego</span>` : ""}</div>
      <div class="ifl">${ps.map(p => itile(r, p)).join("")}</div></div>`;
  }).join("")}</div>`;
}
const rnames = Object.keys(byR).sort((a, b) => (a.startsWith("(") - b.startsWith("(")) || a.localeCompare(b));
const sections = rnames.map(n => {
  const r = RT[n], ls = byR[n], pr = P.filter(p => p.h === n || ls.some(l => l.g && l.g.n === p.h)).sort((a, b) => b.sev - a.sev);
  const okN = ls.filter(l => l.st === "ok" || l.st === "warn").length;
  const st = ls.some(l => l.st === "crit") || pr.some(p => p.sev >= 4) ? (okN ? "warn" : "crit") : ls.some(l => l.st === "warn") || pr.length ? "warn" : "ok";
  const rx = ls.reduce((a, l) => a + ((l.p && l.p.rx) || 0), 0), tx = ls.reduce((a, l) => a + ((l.p && l.p.tx) || 0), 0);
  const capD = ls.reduce((a, l) => a + (l.down ? l.down * 1e6 : 0), 0);
  const temp = r && r.temp.filter(t => t != null).length ? Math.max(...r.temp.filter(t => t != null)) : null;
  return `<section class="swc ${ls.length && !okN ? "crit" : st}">
    <div class="swh"><b>${esc(n)}</b>
      ${ls.length ? `<span class="kv">links ok <em class="${okN < ls.length ? "hot" : ""}">${okN}/${ls.length}</em></span>
      <span class="kv">internet ↓ <em>${bps(rx)}</em>${capD ? ` <span class="of">/ ${cap(capD)}</span>` : ""} ↑ <em>${bps(tx)}</em></span>` : ""}
      ${r ? `<span class="kv">CPU <em class="${(r.cpu || 0) >= 80 ? "hot" : ""}">${r.cpu == null ? "—" : Math.round(r.cpu) + "%"}</em></span>
      <span class="kv">MEM <em>${r.mem == null ? "—" : Math.round(r.mem) + "%"}</em></span>
      ${temp != null ? `<span class="kv">temp <em class="${temp >= 60 ? "hot" : ""}">${Math.round(temp)}°C</em></span>` : ""}
      <span class="kv">uptime <em>${dur(r.up)}</em></span>` : ""}</div>
    ${ls.length ? `<div class="lks">${ls.map(card).join("")}</div>` : r ? `<div class="lk-hint" style="margin-bottom:8px">Nenhum link identificado neste roteador. No MikroTik: <b>/interface set &lt;porta&gt; comment="WAN-OPERADORA 500/250"</b> (down/up contratados em Mbps), ou inclua WAN no nome da interface.</div>` : ""}
    ${r ? ifaces(r, ls) : ""}
  </section>`;
}).join("");

const PQ = [...P].sort((a, b) => b.sev - a.sev || b.ts - a.ts);
const all = links.filter(l => l.r || l.g), up = all.filter(l => l.st === "ok" || l.st === "warn").length;
const kst = !all.length ? "" : up === 0 ? "crit" : up < all.length ? "warn" : "ok";
const fmtH = t => new Date(t).toLocaleTimeString("pt-BR");
const baseUrl = location.pathname.replace(/\/d\/.*$/, "");
const sumC = all.length ? `<div class="lk-sum ${kst}"><b>${up === all.length ? "Internet OK" : up === 0 ? "SEM INTERNET" : "Internet em contingência"}</b><span>${up} de ${all.length} links operando</span>
    ${all.filter(l => l.st === "crit").map(l => `<span class="tag crit">${esc(l.nome)} fora</span>`).join("")}${all.filter(l => l.st === "warn").map(l => `<span class="tag warn">${esc(l.nome)} degradado</span>`).join("")}
    ${DETALHE ? `<a class="lk-more" href="${baseUrl}/d/${DETALHE}" target="_top">detalhe dos links ›</a>` : ""}</div>` : "";
if (COMPACTO) root.innerHTML = `<div class="lk-cmp">${sumC}${sections}</div>`;
else root.innerHTML = `<div class="topbar"><span>● Links de internet · ${newest ? "dados de " + fmtH(newest) : "sem timestamp"}</span><span>tela renderizada às ${fmtH(Date.now())}</span></div>
  ${all.length ? `<div class="lk-sum ${kst}"><b>${up === all.length ? "Internet OK" : up === 0 ? "SEM INTERNET" : "Internet em contingência"}</b><span>${up} de ${all.length} links operando</span>
    ${all.filter(l => l.st === "crit").map(l => `<span class="tag crit">${esc(l.nome)} fora</span>`).join("")}${all.filter(l => l.st === "warn").map(l => `<span class="tag warn">${esc(l.nome)} degradado</span>`).join("")}</div>` : ""}
  <div class="main lk-main"><div class="lk-col">${sections}</div>
    <aside class="side"><div class="box"><h2>Atenção <span class="c ${PQ.length ? "" : "z"}">${PQ.length}</span></h2><ul class="q">${PQ.length
      ? PQ.map(p => `<li><span class="bar" style="background:${SEVC[p.sev] || SEVC[0]}"></span><div><div class="h">${esc(p.h)}</div><div class="p"><span class="sev" style="color:${SEVC[p.sev] || SEVC[0]}">${SEV[p.sev] || ""}</span>${esc(p.p)}</div></div><span class="t">${age(p.ts)}</span></li>`).join("")
      : `<li class="empty">Nenhum problema ativo.</li>`}</ul></div></aside></div>
  <div class="lk-leg">↓ azul = download (entrada na porta WAN) · ↑ roxo = upload · tracejado = banda contratada · latência/perda = ping do Zabbix até o gateway da operadora (mede a última milha, não a internet da operadora)</div>`;

/* --- detalhe da interface no hover --- */
function sparkD(a, b) {
  const arr = [...(a || []), ...(b || [])]; if (arr.length < 4) return `<div class="nk-empty">sem histórico</div>`;
  const w = 300, h = 46, mx = Math.max(...arr, 1), line = (s, c) => { const st = w / Math.max(s.length - 1, 1); return `<polyline points="${s.map((v, i) => `${(i * st).toFixed(1)},${(h - v / mx * h).toFixed(1)}`).join(" ")}" fill="none" stroke="${c}" stroke-width="1.5"/>`; };
  return `<svg class="nk-spark" style="height:46px" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${line(a || [], "#38bdf8")}${line(b || [], "#a78bfa")}</svg>`;
}
const row = (k, v) => `<div class="nk-row"><span>${k}</span><span>${v}</span></div>`;
function detail(r, p) {
  const col = p.st === 1 ? "#22c55e" : "#475569";
  return `<div class="nk-head" style="border-color:${col}"><div><b>${esc(p.n)}</b><div class="nk-sub">${esc(r.n)}${p.alias ? " · " + esc(p.alias) : ""}</div></div>
    <span class="badge" style="background:${col}">${(ST[p.st] || "—").toUpperCase()}</span></div>
    <div class="nk-sec"><div class="nk-t">Tráfego · última hora (↓ azul, ↑ roxo)</div>${sparkD(p.rxH, p.txH)}
      ${row("Recebido ↓", bps(p.rx))}${row("Enviado ↑", bps(p.tx))}${row("Pico ↓ / ↑", bps(p.rxH.length ? Math.max(...p.rxH) : null) + " / " + bps(p.txH.length ? Math.max(...p.txH) : null))}
      ${row("Velocidade", p.sp ? cap(p.sp) : "—")}${row("Erros entrada / saída", (p.ein == null ? "—" : p.ein.toFixed(2)) + " / " + (p.eout == null ? "—" : p.eout.toFixed(2)) + " /s")}</div>`;
}
root.style.position = "relative";
let tip = root.querySelector(".nk-card"); if (!tip) { tip = document.createElement("div"); tip.className = "nk-card"; root.appendChild(tip); }
let tipFor = null;
root.onmousemove = e => {
  const c = e.target.closest("[data-i]"); if (!c) { tip.style.display = "none"; tipFor = null; return; }
  const r = RT[c.dataset.r], p = r && r.ifs[c.dataset.i]; if (!p) return;
  const key = r.n + "|" + p.n; if (tipFor !== key) { tip.innerHTML = detail(r, p); tipFor = key; }
  tip.style.display = "block";
  const rb = root.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
  // limites = a área visível do painel (o Grafana corta o que passa da borda do painel) e da janela
  const pv = (root.closest && root.closest("[class*='panel-content'],[class*='panel-container']")) || root.parentElement || root;
  const pb = pv.getBoundingClientRect(), L = Math.max(8, pb.left + 4), R = Math.min(innerWidth - 8, pb.right - 4), T = Math.max(8, pb.top + 4), B = Math.min(innerHeight - 8, pb.bottom - 4);
  let vx = e.clientX + 18, vy = e.clientY + 12;
  if (vx + tw > R) vx = e.clientX - tw - 18; if (vx < L) vx = L;
  if (vy + th > B) vy = e.clientY - th - 12; if (vy < T) vy = T;
  tip.style.left = (vx - rb.left + root.scrollLeft) + "px"; tip.style.top = (vy - rb.top + root.scrollTop) + "px";
};
root.onmouseleave = () => { tip.style.display = "none"; tipFor = null; };

