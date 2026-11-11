/* QUEDAS E ENERGIA - Business Text (afterRender)
 * Lê o histórico do "ICMP: disponível" (1 = responde, 0 = fora) de cada equipamento da sede no período do dashboard
 * e conta quedas, tempo fora e quedas coletivas (vários equipamentos caindo na mesma hora = provável falta de energia).
 * Períodos longos chegam como médias por hora (trends do Zabbix): tudo é calculado por hora, então os números são aproximados
 * para quedas curtas (duas quedas na mesma hora contam como uma).
 * Sem visibilidade não conta: hora com o túnel até a RB fora, ou com a sentinela do próprio host ("Gateway da sede (via túnel)")
 * fora, é ignorada para aquele host - o Zabbix não via a sede, isso não é queda de equipamento (vale também para antes de existir
 * o item do túnel).
 * Perda de pacote isolada (ping que falha 1 ou 2 vezes pelo túnel) não é queda: a hora só conta com QUEDA_MIN_MIN minutos fora.
 */
const COLETIVA_MIN = 3;          // equipamentos COMEÇANDO uma queda na mesma hora (ou na seguinte) = queda coletiva
const QUEDA_MIN_MIN = 3;         // minutos fora na hora para contar como queda (abaixo disso é perda de pacote, não queda)

/* --- helpers --- */
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
const sName = (fr, f) => { const c = f.config || {}; return c.displayNameFromDS || c.displayName || fr.name || f.name || ""; };
const hostOf = (f, n) => { const l = f.labels || {}; return l.host || l.host_name || (n.includes(": ") ? n.split(": ")[0] : n); };
const itemOf = (f, n) => { const l = f.labels || {}; return l.item || (n.includes(": ") ? n.split(": ").slice(1).join(": ") : n); };
const HORA = 3600000, DIA = 86400000;
const durTxt = m => { m = Math.round(m); if (m < 60) return m + " min"; const h = Math.floor(m / 60), r = m % 60; return h < 24 ? `${h}h${r ? String(r).padStart(2, "0") : ""}` : `${Math.floor(h / 24)}d ${h % 24}h`; };
const dataTxt = t => new Date(t).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const diaTxt = t => new Date(t).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
const TIPO_NOME = { switch: "switch", camera: "câmera", ap: "AP", nvr: "NVR", acesso: "acesso", interfone: "interfone", nas: "NAS", roteador: "roteador", outro: "outro" };
const TIPO = n => TIPO_NOME[(NOC.tipos || {})[n]] || "outro";   // tipo de cada host, do noc.yaml

/* --- leitura: por host, a fração da hora fora do ar --- */
const H = {}, G = {}, tunel = {};  // H[host][hora] = {s: soma de (1-v)*dt, d: soma de dt}; G = sentinela do host; tunel[hora] = idem
let tMin = Infinity, tMax = -Infinity; const dts = [];
for (const fr of series) {
  const tf = (fr.fields || []).find(f => f.type === "time"); if (!tf) continue;
  const ts = vals(tf);
  for (const f of fr.fields || []) {
    if (f.type !== "number") continue;
    const nm = sName(fr, f), h = hostOf(f, nm), it = itemOf(f, nm), v = vals(f);
    const alvo = /Túnel até a RB/i.test(it) ? tunel : /^Gateway d[oa] (site|sede)/i.test(it) ? (G[h] = G[h] || {}) : (/^ICMP: disponível$|^ICMP ping$/i.test(it) ? (H[h] = H[h] || {}) : null);
    if (!alvo) continue;
    for (let i = 0; i < ts.length; i++) {
      if (v[i] == null || Number.isNaN(v[i])) continue;
      const t = ts[i], prox = i + 1 < ts.length ? ts[i + 1] - t : null;
      if (prox != null && prox > 0) dts.push(prox);
      const dt = Math.min(prox != null && prox > 0 ? prox : HORA, HORA);     // amostra vale até a próxima (máx. 1h)
      const b = Math.floor(t / HORA) * HORA, c = alvo[b] = alvo[b] || { s: 0, d: 0 };
      c.s += (1 - Math.max(0, Math.min(1, v[i]))) * dt; c.d += dt;
      if (t < tMin) tMin = t; if (t > tMax) tMax = t;
    }
  }
}
const hosts = Object.keys(H).filter(h => TIPO(h) !== "roteador").sort();
if (!hosts.length) {
  root.innerHTML = `<div class="dbg">Quedas: nenhum dado de "ICMP: disponível" no período.\nConfira o datasource, o período do dashboard e se os hosts do site têm os templates NOC (Switch, Câmera, AP...).</div>`;
  return;
}
dts.sort((a, b) => a - b);
const passo = dts.length ? dts[Math.floor(dts.length / 2)] : HORA, porHora = passo >= 30 * 60000;
const frac = c => c && c.d ? c.s / c.d : 0;
// sentinela média da hora (para host sem sentinela própria, como o NAS)
const gHosts = Object.keys(G), gMed = {};
const gMedia = b => { if (b in gMed) return gMed[b]; const c = gHosts.map(h => G[h][b]).filter(x => x && x.d); return (gMed[b] = c.length ? c.reduce((a, x) => a + frac(x), 0) / c.length : 0); };
const gwFrac = (h, b) => Math.max(frac(tunel[b]), G[h] ? frac(G[h][b]) : gMedia(b));   // fração da hora sem visibilidade para este host
const semVis = (h, b) => gwFrac(h, b) >= 0.5;
const minBruto = (h, b) => { const c = H[h][b]; if (!c || !c.d || semVis(h, b)) return 0; return Math.max(0, frac(c) - gwFrac(h, b)) * 60; };
const minFora = (h, b) => { const m = minBruto(h, b); return m >= QUEDA_MIN_MIN ? m : 0; };

/* --- quedas por equipamento: horas seguidas com queda = uma queda --- */
const horas = []; for (let b = Math.floor(tMin / HORA) * HORA; b <= tMax; b += HORA) horas.push(b);
const QUEDAS = [];                 // { h, ini, min }
const R = hosts.map(h => {
  let quedas = 0, min = 0, q = null, ultima = null, cobertas = 0;
  for (const b of horas) {
    const c = H[h][b]; if (c && c.d && !semVis(h, b)) cobertas++;
    const m = minFora(h, b);
    if (m > 0) { min += m; if (!q) { quedas++; q = { h, ini: b, min: 0 }; QUEDAS.push(q); } q.min += m; ultima = b; } else q = null;
  }
  return { h, tipo: TIPO(h), quedas, min, ultima, disp: cobertas ? 100 - min / (cobertas * 60) * 100 : null };
});

/* --- quedas coletivas: COLETIVA_MIN ou mais equipamentos COMEÇANDO a cair na mesma hora (ou na seguinte).
 * Conta o início junto, não quem continua fora: um equipamento que ficou dias fora não emenda uma queda na outra. */
const COL = []; { const porHoraIni = {}; QUEDAS.forEach(q => (porHoraIni[q.ini] = porHoraIni[q.ini] || []).push(q));
  let cur = null;
  for (const b of horas) {
    const qs = porHoraIni[b] || [];
    if (qs.length && cur && b - cur.ult <= HORA) { cur.q.push(...qs); cur.ult = b; continue; }
    if (cur && cur.q.length >= COLETIVA_MIN) COL.push(cur);
    cur = qs.length ? { ini: b, ult: b, q: qs.slice() } : null;
  }
  if (cur && cur.q.length >= COLETIVA_MIN) COL.push(cur);
  COL.forEach(c => { c.eq = new Set(c.q.map(q => q.h)); const ds = c.q.map(q => q.min).sort((a, b) => a - b); c.min = ds[Math.floor(ds.length / 2)]; c.max = ds[ds.length - 1]; });
}
// horas sem visibilidade da sede: túnel fora, ou a sentinela fora na maioria dos hosts
const semVisHora = b => frac(tunel[b]) >= 0.5 || gMedia(b) >= 0.5;
const horasTunel = horas.filter(semVisHora).length;
const nvr = R.find(r => r.tipo === "NVR");

/* --- mapa de calor: linha por equipamento de infraestrutura + câmeras agrupadas; coluna por dia --- */
// dias pelo calendário (não por 24h fixas: no dia da mudança de horário o dia tem 23 ou 25 horas)
const dias = [], fimDia = {}; { const d0 = new Date(tMin); d0.setHours(0, 0, 0, 0);
  for (let d = new Date(d0); d.getTime() <= tMax; d.setDate(d.getDate() + 1)) { const a = d.getTime(), z = new Date(d); z.setDate(z.getDate() + 1); dias.push(a); fimDia[a] = z.getTime(); } }
const doDia = d => horas.filter(b => b >= d && b < fimDia[d]);
const minDia = (h, d) => doDia(d).reduce((a, b) => a + minFora(h, b), 0);
const ORD_T = { switch: 0, NVR: 1, NAS: 2, AP: 3, TVIP: 4, acesso: 5 };
const infra = hosts.filter(h => TIPO(h) !== "câmera").sort((a, b) => (ORD_T[TIPO(a)] - ORD_T[TIPO(b)]) || a.localeCompare(b));
const cams = hosts.filter(h => TIPO(h) === "câmera");
const cor = m => m <= 0 ? "z" : m < 5 ? "c1" : m < 30 ? "c2" : m < 120 ? "c3" : "c4";
const celHost = (h, d) => { const m = minDia(h, d); return `<td class="hm ${cor(m)}" title="${esc(h)} · ${diaTxt(d)} · ${m >= 1 ? durTxt(m) + " fora" : "sem queda"}"></td>`; };
const celCams = d => { const fora = cams.filter(h => minDia(h, d) >= QUEDA_MIN_MIN), m = fora.length ? Math.max(...fora.map(h => minDia(h, d))) : 0;
  return `<td class="hm ${cor(m)}" title="Câmeras · ${diaTxt(d)} · ${fora.length ? fora.length + " câmera(s) com queda, até " + durTxt(m) : "sem queda"}">${fora.length > 1 ? fora.length : ""}</td>`; };
const diaTun = d => doDia(d).filter(semVisHora).length;
const heat = `<table class="hmap"><thead><tr><th></th>${dias.map(d => `<th title="${diaTxt(d)}">${new Date(d).getDate()}</th>`).join("")}</tr></thead><tbody>
  ${infra.map(h => `<tr><td class="hn">${esc(h)}</td>${dias.map(d => celHost(h, d)).join("")}</tr>`).join("")}
  ${cams.length ? `<tr class="hc"><td class="hn">Câmeras (${cams.length})</td>${dias.map(celCams).join("")}</tr>` : ""}
  ${horasTunel ? `<tr class="ht"><td class="hn">Sem visibilidade (túnel/roteador)</td>${dias.map(d => { const n = diaTun(d); return `<td class="hm ${n ? "tun" : "z"}" title="${diaTxt(d)} · ${n ? n + "h com o túnel fora: horas ignoradas" : "túnel ok"}"></td>`; }).join("")}</tr>` : ""}
</tbody></table>`;

/* --- tela --- */
const kpi = (l, v, s, cls) => `<div class="kpi ${cls}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
const top = R.filter(r => r.quedas).sort((a, b) => b.quedas - a.quedas || b.min - a.min);
const infraTop = top.filter(r => r.tipo !== "câmera"), camTop = top.filter(r => r.tipo === "câmera");
const periodo = `${diaTxt(tMin)} a ${diaTxt(tMax)} · ${dias.length} dia(s)`;
root.innerHTML = `<div class="topbar"><span>● Quedas e energia · ${periodo}${porHora ? " · dados por hora (aproximado)" : ""}</span><span>tela renderizada às ${new Date().toLocaleTimeString("pt-BR")}</span></div>
<section class="kpis qd-kpis">
  ${kpi("Quedas coletivas", COL.length, `${COLETIVA_MIN}+ equipamentos caindo juntos · provável energia`, COL.length ? "crit" : "ok")}
  ${kpi("NVR fora (sem gravar)", nvr ? durTxt(nvr.min) : "—", nvr ? `${nvr.quedas} queda(s) no período` : "NVR sem dados", nvr && nvr.min ? "crit" : "ok")}
  ${kpi("Mais quedas (infra)", infraTop.length ? esc(infraTop[0].h) : "—", infraTop.length ? `${infraTop[0].quedas} queda(s) · ${durTxt(infraTop[0].min)} fora` : "nenhuma queda", infraTop.length ? "warn" : "ok")}
  ${kpi("Equipamentos com queda", `${top.length}<span> / ${R.length}</span>`, `${top.filter(r => r.tipo === "câmera").length} câmera(s)`, top.length ? "warn" : "ok")}
  ${kpi("Sem visibilidade", horasTunel ? durTxt(horasTunel * 60) : "—", horasTunel ? "túnel ou roteador fora: horas ignoradas" : NOC.site_nome + " esteve sempre visível", horasTunel ? "warn" : "ok")}
</section>
<div class="box qd-box"><h2>Minutos fora por dia</h2><div class="qd-scroll">${heat}</div>
  <div class="qd-leg"><span><i class="hm z"></i>sem queda</span><span><i class="hm c1"></i>&lt; 5 min</span><span><i class="hm c2"></i>5–30 min</span><span><i class="hm c3"></i>30 min–2h</span><span><i class="hm c4"></i>&gt; 2h</span>${horasTunel ? `<span><i class="hm tun"></i>sem visibilidade (não conta)</span>` : ""}<span>· na linha Câmeras, o número é quantas caíram no dia</span></div></div>
<div class="qd-grid">
  <div class="box"><h2>Quedas coletivas <span class="c ${COL.length ? "" : "z"}">${COL.length}</span></h2>
    ${COL.length ? `<table class="qt"><tr><th>Início</th><th>Duração</th><th>Equip.</th><th>Quais</th></tr>${COL.slice().reverse().map(c => { const eq = [...c.eq], inf = eq.filter(h => TIPO(h) !== "câmera"), nc = eq.length - inf.length;
      return `<tr><td>${dataTxt(c.ini)}</td><td title="metade dos equipamentos voltou em até ${durTxt(c.min)}; o último em ${durTxt(c.max)}">${durTxt(c.min)}${c.max > c.min * 2 ? ` <span class="qd-sub">(até ${durTxt(c.max)})</span>` : ""}</td><td>${eq.length}</td><td>${esc(inf.join(", "))}${nc ? `${inf.length ? " + " : ""}${nc} câmera(s)` : ""}</td></tr>`; }).join("")}</table>`
      : `<div class="nk-empty">Nenhum momento com ${COLETIVA_MIN} ou mais equipamentos caindo juntos.</div>`}</div>
  <div class="box"><h2>Por equipamento <span class="qd-sub">infraestrutura; câmeras somadas na última linha</span></h2>
    ${top.length ? `<table class="qt"><tr><th>Equipamento</th><th>Tipo</th><th>Quedas</th><th>Tempo fora</th><th>Disp.</th><th>Última</th></tr>${infraTop.map(r => `<tr><td>${esc(r.h)}</td><td>${r.tipo}</td><td>${r.quedas}</td><td>${durTxt(r.min)}</td><td>${r.disp == null ? "—" : r.disp.toFixed(2) + "%"}</td><td>${r.ultima ? dataTxt(r.ultima) : "—"}</td></tr>`).join("")}${camTop.length ? `<tr class="qc"><td title="${esc(camTop.map(r => ((NOC.rotulos || {})[r.h] || r.h) + " (" + r.quedas + ")").join(", "))}">Câmeras: ${camTop.length} de ${cams.length} com queda</td><td>câmera</td><td>${camTop.reduce((a, r) => a + r.quedas, 0)}</td><td>${durTxt(camTop.reduce((a, r) => a + r.min, 0))}</td><td>—</td><td>${dataTxt(Math.max(...camTop.map(r => r.ultima)))}</td></tr>` : ""}</table>
      ${camTop.length ? `<div class="nk-empty qd-nota">Mais quedas entre as câmeras: ${esc(camTop.slice(0, 5).map(r => ((NOC.rotulos || {})[r.h] || r.h) + " (" + r.quedas + ")").join(", "))}. A maioria cai junto com o switch: veja Quedas coletivas.</div>` : ""}`
      : `<div class="nk-empty">Nenhuma queda no período.</div>`}</div>
</div>`;

