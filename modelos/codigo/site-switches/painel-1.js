/* NOC Evento - FRENTE DO SWITCH (Business Text, afterRender)
 * Queries: P = interfaces (status, tráfego, velocidade, erros) dos switches
 *          S = sistema (CPU, memória, temperatura, uptime, fontes/ventoinhas)
 *          F = problemas
 * Funciona com os templates oficiais "Cisco IOS by SNMP", "Huawei VRP by SNMP" e "Network Generic Device by SNMP":
 * item "Interface <nome>(<descrição>): <métrica>".
 */
const UTIL_ATENCAO = 70, UTIL_CRITICO = 90;   // % de uso da porta (maior sentido) para amarelo / vermelho

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

/* --- leitura --- */
const SW = {}, debug = [];
let problems = [], newest = 0;
const sw = h => (SW[h] = SW[h] || { n: h, ports: {}, cpu: null, mem: null, temp: [], up: null, psu: [], fan: [] });
for (const fr of series) {
  const ref = fr.refId || "";
  const tf = (fr.fields || []).find(f => f.type === "time");
  if (tf && ref !== "F") { const t = lastNN(vals(tf)); if (t > newest) newest = t; }
  for (const f of fr.fields || []) {
    const v = vals(f);
    debug.push(`[${ref}] ${sName(fr, f)} type=${f.type} n=${v.length}`);
    if (ref === "F") { if (v.length && typeof v[0] === "object" && v[0] !== null) problems = problems.concat(v); continue; }
    if (f.type !== "number") continue;
    const nm = sName(fr, f), h = hostOf(f, nm), it = itemOf(f, nm), x = lastNN(v);
    if (!h) continue;
    const s = sw(h);
    if (ref === "P") {
      /* "Interface <nome>(<descrição>): <métrica>" ou "Interface <nome>: <métrica>"; o nome pode ter espaços e ":" (Intelbras "gigabitEthernet 1/0/1 : copper") */
      const m = it.match(/^Interface\s+(.+):\s*(Operational status|Bits received|Bits sent|Speed|Inbound packets with errors|Outbound packets with errors|Duplex status)$/i);
      if (!m) continue;
      const full = m[1].trim(), pa = full.match(/^(.*?)\((.*)\)$/);
      const pn0 = pa ? pa[1].trim() : full, pn = normPort(pn0), alias = (pa ? pa[2] : "").replace(/^\S+\s+Interface$/i, "")  /* Intelbras: descrição padrão "GigabitEthernet1/0/25 Interface" = sem descrição */, met = m[2];
      const p = s.ports[pn] = s.ports[pn] || { n: pn, fib: /:\s*fiber\s*$/i.test(pn0), alias, st: null, rx: null, tx: null, sp: null, ein: null, eout: null, dup: null, rxH: [], txH: [] };
      if (/Operational status/i.test(met)) p.st = x;
      else if (/Bits received/i.test(met)) { p.rx = x; p.rxH = v.filter(n => n != null).slice(-60); }
      else if (/Bits sent/i.test(met)) { p.tx = x; p.txH = v.filter(n => n != null).slice(-60); }
      else if (/Speed/i.test(met)) p.sp = x;
      else if (/Inbound packets with errors/i.test(met)) p.ein = x;
      else if (/Outbound packets with errors/i.test(met)) p.eout = x;
      else if (/Duplex/i.test(met)) p.dup = x;
    } else if (ref === "S") {
      if (/CPU utilization/i.test(it)) s.cpu = s.cpu == null ? x : Math.max(s.cpu, x);
      else if (/Memory utilization/i.test(it)) s.mem = s.mem == null ? x : Math.max(s.mem, x);
      else if (/Temperature/i.test(it)) s.temp.push({ n: it.replace(/:\s*Temperature.*/i, ""), v: x });
      else if (/Uptime/i.test(it)) s.up = s.up == null ? x : Math.max(s.up, x);
      else if (/Power supply status/i.test(it)) s.psu.push({ n: it.replace(/:\s*Power supply status.*/i, ""), v: x });
      else if (/Fan status/i.test(it)) s.fan.push({ n: it.replace(/:\s*Fan status.*/i, ""), v: x });
    }
  }
}
const P = problems.map(p => { const hs = p.hosts && p.hosts[0]; let ts = Number(p.lastchange || p.timestamp || 0); if (ts > 1e12) ts /= 1000;
  return { h: (hs && (hs.name || hs.host)) || p.host || "?", p: p.name || p.description || "", sev: Number(p.severity != null ? p.severity : p.priority) || 0, ts }; });

const LIST = Object.values(SW).filter(s => Object.keys(s.ports).length).sort((a, b) => a.n.localeCompare(b.n));
if (!LIST.length) {
  root.innerHTML = `<div class="dbg">Switch: nenhuma interface reconhecida.\nConfira se o host tem o template oficial do fabricante e se a descoberta de interfaces já rodou (Latest data → "Interface ...").\n\n${esc(debug.slice(0, 80).join("\n") || "Nenhum dado recebido.")}</div>`;
  return;
}

/* --- portas físicas e layout --- */
/* nomes de porta fora do padrão: Intelbras "gigabitEthernet 1/0/1 : copper" -> "gigabitEthernet1/0/1"; "ge1" (1 número) conta como física */
function normPort(n) { return String(n).trim().replace(/\s*:\s*(copper|fiber|combo)\s*$/i, "").replace(/^([A-Za-z-]+)\s+(?=\d)/, "$1"); }
function isPhys(n) { const k = (n.match(/\d+/g) || []).length; return PHYS.test(n) && (k >= 2 || /^(ge|fe|xe|port)\d+$/i.test(n)); }
const SFP = /^(Te|Tw|Fo|Hu|TenGig|TwentyFive|Forty|Hundred|XGigabit|XGE|25GE|40GE|100GE|sfp|qsfp)/i;
const PHYS = /^\d+\/\d+\/\d+$|^(Gi|Fa|Te|Tw|Fo|Hu|GigabitEthernet|FastEthernet|TenGigabitEthernet|TwentyFiveGig|FortyGig|HundredGig|XGigabitEthernet|XGE|MultiGE|Ethernet|ether|sfp|qsfp|25GE|40GE|100GE|GE)\S*?\d/i;
function parse(pn) {
  const nums = (pn.match(/\d+/g) || []).map(Number);
  const port = nums.length ? nums[nums.length - 1] : 0;
  const unit = nums.length >= 3 ? nums[0] : (nums.length === 2 ? 0 : 0);
  const mod = nums.length >= 3 ? nums[nums.length - 2] : (nums.length === 2 ? nums[0] : 0);
  return { unit, mod, port, sfp: SFP.test(pn) };
}
const short = pn => pn.replace(/^GigabitEthernet/i, "Gi").replace(/^XGigabitEthernet/i, "XGE").replace(/^TenGigabitEthernet/i, "Te").replace(/^FastEthernet/i, "Fa");
const util = p => (p.sp && p.sp > 0) ? Math.max(p.rx || 0, p.tx || 0) / p.sp * 100 : null;
const bps = b => { if (b == null) return "—"; const u = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"]; let i = 0; while (b >= 1000 && i < 4) { b /= 1000; i++; } return b.toFixed(i ? 1 : 0) + " " + u[i]; };
const spd = b => !b ? "—" : b >= 1e9 ? (b / 1e9) + "G" : (b / 1e6) + "M";
const ST = { 1: "up", 2: "down", 3: "testing", 4: "unknown", 5: "dormant", 6: "notPresent", 7: "lowerLayerDown" };
function pstate(p) {
  if (p.st === 1) { const u = util(p); if ((p.ein || 0) + (p.eout || 0) > 0) return "err"; if (u != null && u >= UTIL_CRITICO) return "hot"; if (u != null && u >= UTIL_ATENCAO) return "warm"; return (p.rx || 0) + (p.tx || 0) > 100000 ? "busy" : "up"; }
  return p.st == null ? "unk" : "down";
}

function physOf(s) {
  const pos = {};
  Object.values(s.ports).filter(p => isPhys(p.n)).forEach(p => {
    const q = parse(p.n), k = (q.mod > 0 ? "" : p.n.replace(/[\d\/.:]+$/, "")) + q.unit + "/" + q.mod + "/" + q.port, cur = pos[k];
    const score = x => (x.st === 1 ? 2 : 0) + (SFP.test(x.n) ? 1 : 0);
    if (!cur || score(p) > score(cur)) pos[k] = p;
  });
  return Object.values(pos);
}
function chassis(s) {
  // físicas com pelo menos 2 números (descarta Fa0/mgmt). Módulo de uplink do 3750-X aparece como Gi e Te na mesma
  // posição: fica uma só por posição (a que estiver up; empate = Te)
  const pos = {};
  Object.values(s.ports).filter(p => isPhys(p.n)).forEach(p => {
    const q = parse(p.n), k = (q.mod > 0 ? "" : p.n.replace(/[\d\/.:]+$/, "")) + q.unit + "/" + q.mod + "/" + q.port, cur = pos[k];
    const score = x => (x.st === 1 ? 2 : 0) + (SFP.test(x.n) ? 1 : 0);
    if (!cur || score(p) > score(cur)) pos[k] = p;
  });
  const phys = Object.values(pos);
  const units = {};
  phys.forEach(p => { const q = parse(p.n); (units[q.unit] = units[q.unit] || []).push(Object.assign(p, q, p.fib ? { sfp: true } : {})); });
  // módulo de uplink = qualquer módulo acima do primeiro da unidade (Cisco Gi4/1/x sobre Gi4/0/x; Ruckus ICX 1/2/x sobre 1/1/x)
  Object.values(units).forEach(ps => { const m0 = Math.min(...ps.map(p => p.mod)); ps.forEach(p => { if (p.mod > m0) p.sfp = true; }); });
  return Object.keys(units).sort((a, b) => a - b).map(u => {
    const ps = units[u];
    // portas "principais" = módulo com mais portas e não-SFP; o resto vai para o bloco de uplink à direita
    const byMod = {}; ps.forEach(p => (byMod[p.mod + (p.sfp ? "s" : "")] = byMod[p.mod + (p.sfp ? "s" : "")] || []).push(p));
    const mainKey = Object.keys(byMod).filter(k => !k.endsWith("s")).sort((a, b) => byMod[b].length - byMod[a].length)[0];
    const main = (byMod[mainKey] || []).sort((a, b) => a.port - b.port);
    const up = ps.filter(p => !main.includes(p)).sort((a, b) => (a.mod - b.mod) || (a.port - b.port));
    const upTop = up.filter(p => p.port % 2 === 1), upBot = up.filter(p => p.port % 2 === 0);
    const port = p => { const st = pstate(p); return `<div class="pt ${p.sfp ? "sfp" : "rj"} ${st}" data-sw="${esc(s.n)}" data-p="${esc(p.n)}"><span>${p.port}</span></div>`; };
    // odd em cima, par embaixo, em grupos de 12 (como o painel frontal)
    const top = main.filter(p => p.port % 2 === 1), bot = main.filter(p => p.port % 2 === 0);
    const groups = [];
    for (let i = 0; i < Math.max(top.length, bot.length); i += 6)
      groups.push(`<div class="swg"><div class="swr">${top.slice(i, i + 6).map(port).join("")}</div><div class="swr">${bot.slice(i, i + 6).map(port).join("")}</div></div>`);
    const upHtml = up.length ? `<div class="swg upl"><div class="swr">${upTop.map(port).join("")}</div><div class="swr">${upBot.map(port).join("")}</div></div>` : "";
    return `<div class="chassis"><div class="unit">${Object.keys(units).length > 1 ? "membro " + u : ""}</div><div class="face">${groups.join("")}${upHtml}</div></div>`;
  }).join("");
}

const age = ts => { if (!ts) return ""; let x = Math.floor(Date.now() / 1000 - ts); const d = Math.floor(x / 86400), h = Math.floor(x % 86400 / 3600), m = Math.floor(x % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
const dur = x => { if (x == null) return "—"; x = Math.floor(x); const d = Math.floor(x / 86400), h = Math.floor(x % 86400 / 3600); return d ? `${d}d ${h}h` : `${h}h ${Math.floor(x % 3600 / 60)}m`; };
const SEV = ["N/C", "Info", "Warning", "Average", "High", "Disaster"], SEVC = ["#6b7280", "#38bdf8", "#f5b301", "#fb923c", "#ef4444", "#b91c1c"];

const html = LIST.map(s => {
  const ps = physOf(s);
  const nUp = ps.filter(p => p.st === 1).length, nErr = ps.filter(p => p.st === 1 && (p.ein || 0) + (p.eout || 0) > 0).length;
  const rx = ps.reduce((a, p) => a + (p.rx || 0), 0), tx = ps.reduce((a, p) => a + (p.tx || 0), 0);
  const top = ps.filter(p => p.st === 1).sort((a, b) => ((b.rx || 0) + (b.tx || 0)) - ((a.rx || 0) + (a.tx || 0))).slice(0, 6);
  const pr = P.filter(p => p.h === s.n).sort((a, b) => b.sev - a.sev);
  const temp = s.temp.filter(t => t.v != null).sort((a, b) => b.v - a.v)[0];
  const bad = arr => arr.filter(x => x.v != null && x.v !== 1).length;   // ENTITY/CISCO-ENVMON: 1 = normal
  return `<section class="swc ${pr.some(p => p.sev >= 4) ? "crit" : pr.length ? "warn" : "ok"}">
    <div class="swh"><b>${esc(s.n)}</b>
      <span class="kv">portas up <em>${nUp}/${ps.length}</em></span>
      <span class="kv">tráfego ↓ <em>${bps(rx)}</em> ↑ <em>${bps(tx)}</em></span>
      <span class="kv">CPU <em>${s.cpu == null ? "—" : Math.round(s.cpu) + "%"}</em></span>
      <span class="kv">MEM <em>${s.mem == null ? "—" : Math.round(s.mem) + "%"}</em></span>
      ${temp ? `<span class="kv">temp <em class="${temp.v >= 55 ? "hot" : ""}">${Math.round(temp.v)}°C</em></span>` : ""}
      <span class="kv">uptime <em>${dur(s.up)}</em></span>
      ${s.psu.length ? `<span class="kv">fontes <em class="${bad(s.psu) ? "hot" : ""}">${s.psu.length - bad(s.psu)}/${s.psu.length} ok</em></span>` : ""}
      ${s.fan.length ? `<span class="kv">ventoinhas <em class="${bad(s.fan) ? "hot" : ""}">${s.fan.length - bad(s.fan)}/${s.fan.length} ok</em></span>` : ""}
      ${nErr ? `<span class="tag warn">${nErr} porta(s) com erro</span>` : ""}</div>
    ${chassis(s)}
    <div class="swb"><div class="tops"><div class="nk-t">Portas com mais tráfego</div>${top.map(p => `<div class="tp" data-sw="${esc(s.n)}" data-p="${esc(p.n)}"><span>${esc(short(p.n))}</span><span class="al">${esc(p.alias)}</span><span>↓ ${bps(p.rx)}</span><span>↑ ${bps(p.tx)}</span><span>${util(p) == null ? "" : Math.round(util(p)) + "%"}</span></div>`).join("") || `<div class="nk-empty">sem tráfego</div>`}</div>
      <div class="prs"><div class="nk-t">Problemas (${pr.length})</div>${pr.slice(0, 6).map(p => `<div class="nk-pr"><span class="sev" style="color:${SEVC[p.sev]}">${SEV[p.sev]}</span>${esc(p.p)}<span class="nk-age">${age(p.ts)}</span></div>`).join("") || `<div class="nk-empty">Nenhum</div>`}</div></div>
  </section>`;
}).join("");

const fmtH = t => new Date(t).toLocaleTimeString("pt-BR");
root.innerHTML = `<div class="topbar"><span>● Switches de borda · ${newest ? "dados de " + fmtH(newest) : "sem timestamp"}</span><span>tela renderizada às ${fmtH(Date.now())}</span></div>
  <div class="lgd"><span class="pt rj up"></span>up <span class="pt rj busy"></span>com tráfego <span class="pt rj warm"></span>uso ≥ ${UTIL_ATENCAO}% <span class="pt rj hot"></span>uso ≥ ${UTIL_CRITICO}% <span class="pt rj err"></span>erros <span class="pt rj down"></span>down/vazia <span class="pt sfp up"></span>SFP/uplink</div>
  ${html}`;

/* --- detalhe da porta no hover --- */
function spark(a, b) {
  const arr = [...(a || []), ...(b || [])]; if (arr.length < 4) return `<div class="nk-empty">sem histórico</div>`;
  const w = 300, h = 46, mx = Math.max(...arr, 1), line = (s, c) => { const st = w / Math.max(s.length - 1, 1); return `<polyline points="${s.map((v, i) => `${(i * st).toFixed(1)},${(h - v / mx * h).toFixed(1)}`).join(" ")}" fill="none" stroke="${c}" stroke-width="1.5"/>`; };
  return `<svg class="nk-spark" style="height:46px" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${line(a || [], "#38bdf8")}${line(b || [], "#a78bfa")}</svg>`;
}
const row = (k, v) => `<div class="nk-row"><span>${k}</span><span>${v}</span></div>`;
function detail(s, p) {
  const st = pstate(p), col = { up: "#22c55e", busy: "#16a34a", warm: "#f5b301", hot: "#ef4444", err: "#fb923c", down: "#475569", unk: "#475569" }[st];
  const u = util(p);
  return `<div class="nk-head" style="border-color:${col}"><div><b>${esc(p.n)}</b><div class="nk-sub">${esc(s.n)}${p.alias ? " · " + esc(p.alias) : ""}</div></div>
    <span class="badge" style="background:${col}">${(ST[p.st] || "—").toUpperCase()}</span></div>
    <div class="nk-sec"><div class="nk-t">Tráfego · última hora (↓ azul, ↑ roxo)</div>${spark(p.rxH, p.txH)}
      ${row("Recebido ↓", bps(p.rx))}${row("Enviado ↑", bps(p.tx))}${row("Velocidade", spd(p.sp))}${row("Uso (maior sentido)", u == null ? "—" : u.toFixed(1) + "%")}</div>
    <div class="nk-sec"><div class="nk-t">Saúde</div>${row("Erros entrada", p.ein == null ? "—" : p.ein.toFixed(2) + " /s")}${row("Erros saída", p.eout == null ? "—" : p.eout.toFixed(2) + " /s")}
      ${p.dup != null ? row("Duplex", p.dup === 3 ? "full" : p.dup === 2 ? "HALF" : "—") : ""}</div>`;
}
root.style.position = "relative";
let tip = root.querySelector(".nk-card"); if (!tip) { tip = document.createElement("div"); tip.className = "nk-card"; root.appendChild(tip); }
let tipFor = null;
root.onmousemove = e => {
  const c = e.target.closest("[data-p]"); if (!c) { tip.style.display = "none"; tipFor = null; return; }
  const s = SW[c.dataset.sw], p = s && s.ports[c.dataset.p]; if (!p) return;
  const key = s.n + "|" + p.n; if (tipFor !== key) { tip.innerHTML = detail(s, p); tipFor = key; }
  tip.style.display = "block";
  posTip(tip, e, root, 18);
};
root.onmouseleave = () => { tip.style.display = "none"; tipFor = null; };

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

