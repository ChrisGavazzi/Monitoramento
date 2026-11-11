const CFG = NOC.cfg;   // título e seções (uma por grupo de hosts do site), montado pelo gerador
/* NOC Evento - painel de FROTA (equipamentos por ping) - Business Text (afterRender)
 * O build injeta antes deste código:  const CFG = { titulo, resumo, secoes:[{ref, titulo, nota, reserva}] }
 * Cada seção é uma query (refId = sec.ref) trazendo, por host:
 *   "ICMP: disponível" (1/0), "ICMP: perda de pacotes" (%), "ICMP: tempo de resposta" (s),
 *   "Serviço TCP ...: disponível" (1/0, NVR/facial), "Modem: sinal (RSSI)" (dBm, Teltonika).
 * F = problemas (query de Problems) dos mesmos grupos.
 * CFG.resumo = true -> visão geral: um bloco por seção com contagem e lista do que está fora.
 */
const PERDA_ALERTA = 20, LATENCIA_ALERTA_MS = 150, ATRASO_MAX_MIN = 5, MAX_FORA_RESUMO = 14;

/* --- compatibilidade entre versões do plugin (igual ao NOC Servidores) --- */
const ctx = (typeof context !== "undefined") ? context : {};
const root0 = ctx.element || (typeof element !== "undefined" ? element : document);
const root = (root0.querySelector && root0.querySelector(".noc")) || root0;
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

const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const vals = f => !f ? [] : (Array.isArray(f.values) ? f.values : (f.values && f.values.toArray ? f.values.toArray() : []));
const lastNN = arr => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null && !Number.isNaN(arr[i])) return arr[i]; return null; };
const seriesName = (fr, f) => { const c = f.config || {}; return c.displayNameFromDS || c.displayName || (f.state && f.state.displayName) || fr.name || f.name || ""; };
const hostOf = (f, name) => { const l = f.labels || {}; return l.host || l.host_name || (name.includes(": ") ? name.split(": ")[0] : name); };
const itemOf = (f, name) => { const l = f.labels || {}; return l.item || (name.includes(": ") ? name.split(": ").slice(1).join(": ") : name); };
const natural = (a, b) => a.localeCompare(b, "pt-BR", { numeric: true });

/* --- leitura --- */
const SEC = CFG.secoes.map(s => Object.assign({ hosts: {} }, s));
const SECBY = Object.fromEntries(SEC.map(s => [s.ref, s]));
let problems = [], newest = 0;
const debug = [];
for (const fr of series) {
  const ref = fr.refId || "";
  const tf = (fr.fields || []).find(f => f.type === "time");
  if (tf && ref !== "F") { const t = lastNN(vals(tf)); if (t > newest) newest = t; }
  for (const f of fr.fields || []) {
    const v = vals(f);
    debug.push(`[${ref}] frame="${fr.name || ""}" field="${f.name}" type=${f.type} labels=${JSON.stringify(f.labels || {})} n=${v.length}`);
    if (ref === "F") { if (v.length && typeof v[0] === "object" && v[0] !== null) problems = problems.concat(v); continue; }
    const sec = SECBY[ref]; if (!sec || f.type !== "number") continue;
    const name = seriesName(fr, f), h = hostOf(f, name), it = itemOf(f, name), x = lastNN(v);
    if (!h) continue;
    // host desabilitado no Zabbix (nome com "(desligado)") e sem coleta: não aparece; se voltar a pingar, aparece sozinho
    if (x == null && /\(desligado\)/i.test(h) && !sec.hosts[h]) continue;
    const o = sec.hosts[h] = sec.hosts[h] || { n: h, sec: sec.titulo, ping: null, loss: null, rtt: null, svc: null, svcN: "", rssi: null,
      res: !!(sec.reserva && new RegExp(sec.reserva).test(h)) };
    if (/ICMP: disponível|ICMP ping$/i.test(it)) o.ping = x;
    else if (/perda|loss/i.test(it)) o.loss = x;
    else if (/tempo de resposta|response time/i.test(it)) o.rtt = x;
    else if (/Serviço TCP/i.test(it)) { o.svc = x; const m = it.match(/TCP\s+(\d+)/); o.svcN = m ? m[1] : (sec.porta ? String(sec.porta) : ""); }
    else if (/RSSI|sinal/i.test(it)) o.rssi = x;
  }
}
const P = problems.map(p => {
  const hs = p.hosts && p.hosts[0];
  let ts = Number(p.timestamp || p.lastchange || p.clock || 0); if (ts > 1e12) ts = ts / 1000;
  const mt = p.suppressed == 1 || p.suppressed === "1" || p.maintenance === true || p.maintenance == 1 || !!(hs && hs.maintenance_status == 1);
  return { h: (hs && (hs.name || hs.host)) || p.host || "?", p: p.name || p.description || "", sev: Number(p.severity != null ? p.severity : p.priority) || 0, ts, mt };
});
const MAINT = new Set(P.filter(p => p.mt).map(p => p.h));
const ALL = SEC.flatMap(s => Object.values(s.hosts));
const PA = P.filter(p => !p.mt && ALL.some(h => h.n === p.h && !h.res));

if (!ALL.length) {
  root.innerHTML = `<div class="dbg">${esc(CFG.titulo)}: nenhum equipamento nas queries.\nConfira o datasource e se os grupos existem no Zabbix.\n\n${esc(debug.join("\n") || "Nenhum dado recebido.")}</div>`;
  return;
}

/* --- estado --- */
const SEV = ["Not classified", "Information", "Warning", "Average", "High", "Disaster"];
const SEVC = ["#6b7280", "#38bdf8", "#f5b301", "#fb923c", "#ef4444", "#b91c1c"];
const ms = s => s == null ? null : s * 1000;
function state(o) {
  if (o.res) return "res";
  if (MAINT.has(o.n)) return "maint";
  if (o.ping === 0) return "crit";
  if (o.ping == null) return "unk";
  if (o.svc === 0) return "crit";
  if ((o.loss != null && o.loss >= PERDA_ALERTA) || (o.rtt != null && ms(o.rtt) >= LATENCIA_ALERTA_MS)) return "warn";
  if (PA.some(p => p.h === o.n && p.sev >= 2)) return "warn";
  return "ok";
}
function motivo(o, st) {
  if (st === "res") return "reserva";
  if (st === "maint") return "manutenção";
  if (o.ping === 0) return "FORA";
  if (o.ping == null) return "sem dados";
  if (o.svc === 0) return o.svcN ? "porta " + o.svcN : "serviço";
  if (o.loss != null && o.loss >= PERDA_ALERTA) return "perda " + Math.round(o.loss) + "%";
  if (o.rssi != null) return Math.round(o.rssi) + " dBm";
  return o.rtt != null ? Math.round(ms(o.rtt)) + " ms" : "";
}
ALL.forEach(o => { o.st = state(o); o.mo = motivo(o, o.st); });
const ord = { crit: 0, warn: 1, unk: 2, maint: 3, ok: 4, res: 5 };
const conta = arr => { const a = arr.filter(o => o.st !== "res" && o.st !== "maint");
  return { n: a.length, on: a.filter(o => o.ping === 1).length, fora: a.filter(o => o.st === "crit").length,
           deg: a.filter(o => o.st === "warn").length, unk: a.filter(o => o.st === "unk").length,
           res: arr.filter(o => o.st === "res").length, mt: arr.filter(o => o.st === "maint").length }; };

/* --- KPIs --- */
const T = conta(ALL), hi = PA.filter(p => p.sev >= 4).length;
const lat = ALL.filter(o => o.ping === 1 && o.rtt != null && !o.res).map(o => ms(o.rtt));
const latAvg = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null;
const pctOn = T.n ? Math.round(T.on / T.n * 100) : 0;
const K = [
  ["Online", `${T.on}<span> / ${T.n}</span>`, T.fora ? "crit" : T.on < T.n ? "warn" : "ok", `${pctOn}% da frota${T.mt ? ` · ${T.mt} em manutenção` : ""}`],
  ["Fora do ar", T.fora, T.fora ? "crit" : "ok", "sem ping ou serviço parado"],
  ["Degradados", T.deg, T.deg ? "warn" : "ok", `perda ≥ ${PERDA_ALERTA}% ou latência ≥ ${LATENCIA_ALERTA_MS} ms`],
  ["Sem dados", T.unk, T.unk ? "warn" : "ok", "ainda sem coleta"],
  CFG.compacto && SEC.length
    ? (() => { const c0 = conta(Object.values(SEC[0].hosts)); return [`${SEC[0].titulo} fora`, c0.fora, c0.fora ? "crit" : "ok", SEC[0].nota || `${c0.on}/${c0.n} online`]; })()
    : ["Latência média", latAvg == null ? "—" : `${latAvg}<span> ms</span>`, latAvg != null && latAvg >= LATENCIA_ALERTA_MS ? "warn" : "", "dos equipamentos online"],
  ["Problemas ativos", PA.length, hi ? "crit" : PA.length ? "warn" : "ok", `${hi} High/Disaster`]
];

/* --- seções --- */
const curto = n => n.replace(/_mylaps$/i, "").replace(/^NVR-DVR-/i, "NVR ").replace(/^ACESSO-CARRETA-/i, "CARRETA ")
  .replace(/\s*\((sem SNMP|desligado|ICX[^)]*)\)/i, "").replace(/^SW Intelbras\s+/i, "INT ").replace(/^SW Ruckus\s+/i, "RKS ")
  .replace(/^AP[- ]10\.0\.0\./i, "AP .").replace(/^(CAM|ACESSO|NVR|SW)-SEDE-/i, "$1 ").replace(/\b10\.0\.(\d+\.\d+)\b/, "$1");
const tile = o => `<div class="tl ${o.st}${o.st === "crit" && o.ping === 1 ? " porta" : ""}" data-n="${esc(o.n)}" title="${esc(o.n)}"><span class="tn">${esc(curto(o.n))}</span><span class="tm">${esc(o.mo)}</span></div>`;
const secHtml = (CFG.resumo ? [...SEC].sort((a, b) => (!Object.keys(a.hosts).length) - (!Object.keys(b.hosts).length)) : SEC).map(s => {
  const hs = Object.values(s.hosts).sort((a, b) => ord[a.st] - ord[b.st] || natural(a.n, b.n)), c = conta(hs);
  const cls = !hs.length ? "vazio" : c.fora ? "crit" : (c.deg || c.unk) ? "warn" : "ok";
  const head = `<div class="sh2"><b>${esc(s.titulo)}</b><span class="cnt ${cls}">${hs.length ? `${c.on}/${c.n} online` : "sem equipamentos"}</span>
    ${c.fora ? `<span class="tag crit">${c.fora} fora</span>` : ""}${c.deg ? `<span class="tag warn">${c.deg} degradado(s)</span>` : ""}
    ${c.unk ? `<span class="tag unk">${c.unk} sem dados</span>` : ""}${c.res ? `<span class="tag res">${c.res} reserva</span>` : ""}
    ${s.nota ? `<span class="nota">${esc(s.nota)}</span>` : ""}</div>`;
  if (!hs.length) return `<section class="sec vazio">${head}<div class="nk-empty">Nenhum host neste grupo no Zabbix ainda.</div></section>`;
  if (CFG.resumo) {
    const fora = hs.filter(o => o.st === "crit" || o.st === "warn");
    const pc = c.n ? Math.round(c.on / c.n * 100) : 0;
    return `<section class="sec rs ${cls}">${head}<div class="rbar"><div class="rfill ${cls}" style="width:${pc}%"></div></div>
      <div class="tiles">${fora.slice(0, MAX_FORA_RESUMO).map(tile).join("")}${fora.length > MAX_FORA_RESUMO ? `<div class="tl mais">+${fora.length - MAX_FORA_RESUMO}</div>` : ""}
      ${!fora.length ? `<div class="okmsg">✓ tudo respondendo</div>` : ""}</div></section>`;
  }
  return `<section class="sec ${cls}">${head}<div class="tiles">${hs.map(tile).join("")}</div></section>`;
}).join("");

/* --- fila de atenção --- */
const age = ts => { if (!ts) return ""; let s = Math.floor(Date.now() / 1000 - ts); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
const Q = [...PA].sort((a, b) => b.sev - a.sev || b.ts - a.ts);
const queueHtml = Q.length ? Q.map(p => `<li data-n="${esc(p.h)}"><span class="bar" style="background:${SEVC[p.sev] || SEVC[0]}"></span>
  <div><div class="h">${esc(p.h)}</div><div class="p"><span class="sev" style="color:${SEVC[p.sev] || SEVC[0]}">${SEV[p.sev] || ""}</span>${esc(p.p)}</div></div><span class="t">${age(p.ts)}</span></li>`).join("")
  : `<li class="empty">Nenhum problema ativo.</li>`;

/* --- dados atrasados --- */
const fmtH = t => new Date(t).toLocaleTimeString("pt-BR");
const atrasoMin = newest ? (Date.now() - newest) / 60000 : null;
const staleHtml = atrasoMin != null && atrasoMin > ATRASO_MAX_MIN
  ? `<div class="stale">⚠ DADOS ATRASADOS — última coleta recebida às ${fmtH(newest)} (há ${Math.round(atrasoMin)} min). Verifique o Zabbix server e o datasource.</div>` : "";

root.innerHTML = `${staleHtml}<div class="topbar"><span class="${staleHtml ? "bad" : ""}">● ${esc(CFG.titulo)} · ${newest ? "dados de " + fmtH(newest) : "sem timestamp"}</span><span>tela renderizada às ${fmtH(Date.now())}</span></div>
  <section class="kpis">${K.map(k => `<div class="kpi ${k[2]}"><div class="l">${k[0]}</div><div class="v">${k[1]}</div><div class="s">${k[3]}</div></div>`).join("")}</section>
  <div class="main"><div class="secs ${CFG.resumo ? "resumo" : ""} ${CFG.compacto ? "compacto" : ""}">${secHtml}</div>
    <aside class="side"><div class="box"><h2>Atenção <span class="c ${Q.length ? "" : "z"}">${Q.length}</span></h2><ul class="q">${queueHtml}</ul></div>
      <div class="box legend"><h2>Legenda</h2><div class="lg"><span class="tl ok"><span class="tn">OK</span></span><span class="tl warn"><span class="tn">degradado</span></span>
      ${CFG.compacto ? `<span class="tl crit"><span class="tn">sem ping</span></span><span class="tl crit porta"><span class="tn">porta fechada</span></span>` : `<span class="tl crit"><span class="tn">fora / porta</span></span>`}<span class="tl unk"><span class="tn">sem dados</span></span><span class="tl res"><span class="tn">reserva</span></span></div></div></aside></div>`;

/* --- detalhe no hover --- */
const row = (k, v) => `<div class="nk-row"><span>${k}</span><span>${v}</span></div>`;
const COL = { crit: "#ef4444", warn: "#f5b301", ok: "#22c55e", unk: "#64748b", maint: "#6b7280", res: "#475569" };
const LBL = { crit: "FORA", warn: "ALERTA", ok: "OK", unk: "SEM DADOS", maint: "MANUTENÇÃO", res: "RESERVA" };
function detail(o) {
  const pr = P.filter(p => p.h === o.n).sort((a, b) => b.sev - a.sev);
  return `<div class="nk-head" style="border-color:${COL[o.st]}"><div><b>${esc(o.n)}</b><div class="nk-sub">${esc(o.sec)}</div></div>
    <span class="badge" style="background:${COL[o.st]}">${LBL[o.st]}</span></div>
    <div class="nk-sec"><div class="nk-t">Rede</div>
      ${row("Ping", o.ping === 1 ? "responde" : o.ping === 0 ? "SEM RESPOSTA" : "—")}
      ${row("Perda de pacotes", o.loss == null ? "—" : Math.round(o.loss) + "%")}
      ${row("Latência", o.rtt == null ? "—" : ms(o.rtt).toFixed(1) + " ms")}
      ${o.svc != null ? row(o.svcN ? "Porta " + esc(o.svcN) : "Serviço", o.svc === 1 ? "aberta" : "FECHADA") : ""}
      ${o.rssi != null ? row("Sinal 4G (RSSI)", Math.round(o.rssi) + " dBm") : ""}</div>
    <div class="nk-sec"><div class="nk-t">Problemas ativos (${pr.length})</div>
      ${pr.length ? pr.map(p => `<div class="nk-pr"><span class="sev" style="color:${SEVC[p.sev] || SEVC[0]}">${SEV[p.sev] || ""}</span>${esc(p.p)}<span class="nk-age">${age(p.ts)}</span></div>`).join("") : `<div class="nk-empty">Nenhum</div>`}</div>`;
}
root.style.position = "relative";
// retângulo visível: janela recortada por cada ancestral que corta o conteúdo (overflow hidden/auto/scroll)
function areaVisivel(el) {
  const B = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  for (let p = el; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (/(hidden|auto|scroll|clip)/.test(cs.overflow + cs.overflowX + cs.overflowY)) { const q = p.getBoundingClientRect();
      B.left = Math.max(B.left, q.left); B.top = Math.max(B.top, q.top); B.right = Math.min(B.right, q.right); B.bottom = Math.min(B.bottom, q.bottom); }
  }
  return B;
}
let tip = root.querySelector(".nk-card");
if (!tip) { tip = document.createElement("div"); tip.className = "nk-card"; root.appendChild(tip); }
let tipFor = null;
root.onmousemove = e => {
  const c = e.target.closest(".tl[data-n], .q li[data-n]");
  if (!c) { tip.style.display = "none"; tipFor = null; return; }
  const o = ALL.find(x => x.n === c.dataset.n); if (!o) { tip.style.display = "none"; return; }
  if (tipFor !== o.n) { tip.innerHTML = detail(o); tipFor = o.n; }
  tip.style.display = "block";
  // limites = área visível do painel (o Grafana corta o que passa da borda do painel), não a janela
  const r = root.getBoundingClientRect(), B = areaVisivel(root);
  tip.style.maxHeight = Math.max(120, B.bottom - B.top - 16) + "px";
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let vx = e.clientX + 18, vy = e.clientY + 12;
  if (vx + tw > B.right - 8) vx = e.clientX - tw - 18;       // sem espaço à direita: abre à esquerda do cursor
  if (vx < B.left + 8) vx = B.left + 8;
  if (vy + th > B.bottom - 8) vy = e.clientY - th - 12;      // sem espaço embaixo: abre acima do cursor
  if (vy + th > B.bottom - 8) vy = B.bottom - 8 - th;
  if (vy < B.top + 8) vy = B.top + 8;
  tip.style.left = (vx - r.left + root.scrollLeft) + "px";
  tip.style.top = (vy - r.top + root.scrollTop) + "px";
};
root.onmouseleave = () => { tip.style.display = "none"; tipFor = null; };

