/* CABEÇALHO das telas (Business Text, afterRender). O mesmo código em todos os dashboards.
 * O gerador (noc.py) coloca antes deste código: const NOC = { empresa, grupo, tela, telas, sites, nuvem, hosts }.
 *   telas: [{ grp, uid, nome }]  grp = id do site ou "nuvem"      sites: [{ id, nome, rtr, links, inicio }]
 *   hosts: { "<host>": "<id do site>" }  (host fora da lista = nuvem)
 * Queries: A = roteadores e hosts LINK-*: "Túnel até a RB: disponível", "WAN <X>: internet", "ICMP: disponível"
 *          F = problemas atuais (todos os grupos)
 */
const DADOS_ATRASO_MIN = 5;          // Zabbix sem dado novo há mais que isso = aviso
const ctx = (typeof context !== "undefined") ? context : {};
const root0 = ctx.element || (typeof element !== "undefined" ? element : document);
const root = (root0.querySelector && root0.querySelector(".noc")) || root0;
const atual = NOC.tela;
const isFrames = a => Array.isArray(a) && a.length && a[0] && Array.isArray(a[0].fields);
function findSeries(o, d, seen) {
  if (!o || typeof o !== "object" || d > 4 || seen.has(o)) return null; seen.add(o);
  if (isFrames(o.series)) return o.series; if (isFrames(o)) return o;
  for (const k of ["panel", "panelData", "data", "series"]) { const r = findSeries(o[k], d + 1, seen); if (r) return r; }
  return null;
}
const series = findSeries(ctx, 0, new Set()) || (typeof panelData !== "undefined" ? findSeries(panelData, 0, new Set()) : null) || [];
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const vals = f => !f ? [] : (Array.isArray(f.values) ? f.values : (f.values && f.values.toArray ? f.values.toArray() : []));
const lastNN = a => { for (let i = a.length - 1; i >= 0; i--) if (a[i] != null && !Number.isNaN(a[i])) return a[i]; return null; };
const sName = (fr, f) => { const c = f.config || {}; return c.displayNameFromDS || c.displayName || fr.name || f.name || ""; };
const itemOf = (f, n) => { const l = f.labels || {}; return l.item || (n.includes(": ") ? n.split(": ").slice(1).join(": ") : n); };

/* --- leitura --- */
let newest = 0, problems = [], temF = false;
const TUN = {}, TUNH = {};     // por site: "Túnel até a RB: disponível" do roteador do site
const WAN = {}, DIRETO = {};   // WAN[<LINK>] = teste do roteador; DIRETO[<LINK>] = ping do IP público (host LINK-<NOME>), da nuvem, sem túnel
const siteDe = h => NOC.hosts[h] || null;
for (const fr of series) {
  const ref = fr.refId || "";
  const tf = (fr.fields || []).find(f => f.type === "time");
  if (tf && ref === "A") { const t = lastNN(vals(tf)); if (t > newest) newest = t; }
  const tv = tf ? vals(tf) : [];
  for (const f of fr.fields || []) {
    const v = vals(f);
    if (ref === "F") { temF = true; if (v.length && typeof v[0] === "object" && v[0] !== null) problems = problems.concat(v); continue; }
    if (f.type !== "number") continue;
    const it = itemOf(f, sName(fr, f)), x = lastNN(v);
    const hn = (f.labels && (f.labels.host || f.labels.host_name)) || (sName(fr, f).split(": ")[0] || "");
    if (/Túnel até a RB/i.test(it)) { const st = siteDe(hn); if (st) { TUN[st] = x; TUNH[st] = { t: tv, v }; } continue; }
    const lk = hn.match(/^LINK-(.+)$/i); if (lk && /ICMP: disponível|ICMP ping/i.test(it)) { DIRETO[lk[1].toUpperCase()] = x; continue; }
    const m = it.match(/^WAN\s+(.+?):\s*internet\b/i);
    if (m) WAN[m[1].trim().toUpperCase()] = x;
  }
}
const P = problems.map(p => {
  const hs = p.hosts && p.hosts[0];
  const hm = p.maintenance === true || p.maintenance === 1 || p.maintenance === "1" || !!(hs && (hs.maintenance_status == 1 || hs.maintenance === true));
  return { h: (hs && (hs.name || hs.host)) || p.host || "?", p: p.name || p.description || "",
           sev: Number(p.severity != null ? p.severity : p.priority) || 0,
           mt: hm || p.suppressed == 1 || p.suppressed === "1", ack: p.acknowledged == 1 || p.acknowledged === "1" || p.acknowledged === true };
});
const SEV = ["Não classificado", "Informação", "Atenção", "Média", "Alta", "Desastre"];
const SEVC = ["#6b7280", "#38bdf8", "#f5b301", "#fb923c", "#ef4444", "#b91c1c"];

/* --- montagem --- */
const base = (window.grafanaBootData && grafanaBootData.settings && grafanaBootData.settings.appSubUrl) || "";
let kq = "";
try { const sp = new URLSearchParams(window.location.search); if (sp.has("kiosk")) kq = sp.get("kiosk") ? "?kiosk=" + encodeURIComponent(sp.get("kiosk")) : "?kiosk"; } catch (e) {}
const ligada = atual;
const url = uid => `${base}/d/${uid}${kq}`;
const grupo = NOC.grupo;
const abas = NOC.telas.filter(t => t.grp === grupo).map(t =>
  `<a class="hd-tab${t.uid === ligada ? " on" : ""}" href="${url(t.uid)}" target="_self">${esc(t.nome)}</a>`).join("");

// links: verde = ok, vermelho = fora; fora com alerta já reconhecido no Zabbix = âmbar (problema conhecido)
const linkPill = (nome, x, title, hostRx) => {
  const reconhecido = x === 0 && P.some(p => p.ack && hostRx.test(p.h) && new RegExp(nome, "i").test(p.p));
  const st = x == null ? "na" : x === 1 ? "ok" : reconhecido ? "ack" : "down";
  const txt = x == null ? "sem dado" : x === 1 ? "ok" : reconhecido ? "fora · reconhecido" : "fora";
  return `<span class="hd-pill ${st}" title="${esc(title + ": " + txt)}"><i></i>${esc(nome)}${x === 1 ? "" : ` <em>${esc(txt)}</em>`}</span>`;
};
const rxEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// túnel voltou há menos de 2 min: o teste de cada link (pelo túnel) ainda está atualizando
const aquecendo = st => { const h = TUNH[st]; if (TUN[st] !== 1 || !h) return false;
  for (let i = h.v.length - 1; i >= 0; i--) if (h.v[i] === 0) return Date.now() - Number(h.t[i]) < 120000; return false; };
const pillsSite = (s, curto) => {
  const temTunel = s.tunel !== false, tun = temTunel ? (TUN[s.id] != null ? TUN[s.id] : null) : 1, aq = temTunel && aquecendo(s.id);
  const hostRx = new RegExp("^(" + [s.rtr].concat(s.links.map(k => "LINK-" + k)).map(rxEsc).join("|") + ")$", "i");
  const semVis = k => aq ? `<span class="hd-pill na" title="O túnel acabou de voltar: o teste do link ${esc(k)} ainda está atualizando"><i></i>${esc(k)} <em>atualizando</em></span>`
    : `<span class="hd-pill na" title="Túnel fora: o Zabbix não alcança o roteador, o estado do link ${esc(k)} é desconhecido"><i></i>${esc(k)} <em>sem visibilidade</em></span>`;
  const out = temTunel ? [linkPill(curto ? "Túnel " + s.nome : "Túnel", tun, `Túnel nuvem ↔ ${s.rtr}`, hostRx)] : [];
  if (curto) return out;
  return out.concat(s.links.map(k => tun !== 0 && !(aq && WAN[k] === 0) ? linkPill(k, WAN[k] != null ? WAN[k] : null, `Internet de ${s.nome} pelo link ${k}`, hostRx)
    : DIRETO[k] != null ? linkPill(k, DIRETO[k], `Túnel fora: estado do link ${k} pelo ping direto ao IP público`, hostRx) : semVis(k)));
};
const siteAtual = NOC.sites.find(s => s.id === grupo);
const pills = siteAtual ? pillsSite(siteAtual, false) : NOC.sites.flatMap(s => pillsSite(s, true));

// problemas: só os que contam (sem silenciados/manutenção); a cor é a do pior
const resumo = (nome, lista, destino, cur, tunFora) => {
  if (!temF) return `<span class="hd-cnt" style="--c:#64748b" title="A consulta de problemas não voltou"><span class="n">—</span><span class="l">${esc(nome)}<br><small>sem dados</small></span></span>`;
  const ativos = lista.filter(p => !p.mt).sort((a, b) => b.sev - a.sev), sil = lista.length - ativos.length;
  const pior = ativos.length ? ativos[0].sev : -1;
  const dica = ativos.length ? ativos.slice(0, 10).map(p => `${SEV[p.sev] || ""} · ${p.h} — ${p.p}${p.ack ? " (reconhecido)" : ""}`).join("\n") + (ativos.length > 10 ? `\n… e mais ${ativos.length - 10}` : "")
                             : "Nenhum problema ativo";
  const cor = tunFora ? SEVC[5] : pior < 0 ? "#22c55e" : SEVC[pior];
  return `<a class="hd-cnt${pior < 0 && !tunFora ? " zero" : ""}${cur ? " cur" : ""}" href="${url(destino)}" target="_self" style="--c:${cor}" title="${esc(dica + (sil ? `\n(${sil} silenciado(s) ou em manutenção, fora da conta)` : ""))}">
    <span class="n">${ativos.length}</span><span class="l">${esc(nome)}<br><small>${tunFora ? "túnel fora" : pior < 0 ? "sem problemas" : esc(SEV[pior])}</small></span></a>`;
};
const contadores = NOC.sites.map(s => resumo(s.nome, P.filter(p => siteDe(p.h) === s.id), s.inicio, grupo === s.id, s.tunel !== false && TUN[s.id] === 0))
  .concat(NOC.nuvem ? [resumo(NOC.nuvem.nome, P.filter(p => !siteDe(p.h)), NOC.nuvem.inicio, grupo === "nuvem", false)] : []).join("");

const agora = Date.now();
const atraso = newest ? Math.round((agora - newest) / 60000) : null;
const dadosAviso = series.length === 0 ? `<span class="hd-pill down" title="O painel não recebeu dados do Zabbix"><i></i>sem dados do Zabbix</span>`
  : (atraso != null && atraso > DADOS_ATRASO_MIN ? `<span class="hd-pill ack" title="Último dado recebido do Zabbix há ${atraso} min"><i></i>dados atrasados <em>${atraso} min</em></span>` : "");
const hhmm = d => d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

root.innerHTML = `<div class="hd">
  <div class="hd-brand"><b>${esc(NOC.empresa)}</b><span>NOC</span></div>
  <div class="hd-sites">${contadores}</div>
  <nav class="hd-tabs">${abas}</nav>
  <div class="hd-st">
    <div class="hd-pills">${dadosAviso}${pills.join("")}</div>
    <div class="hd-clk"><b class="hd-now">${hhmm(new Date())}</b><small>atualizado ${hhmm(new Date(agora))}</small></div>
  </div>
</div>`;

// relógio: um timer só por painel (o afterRender roda de novo a cada atualização)
if (root0.__hdTimer) clearInterval(root0.__hdTimer);
root0.__hdTimer = setInterval(() => { const n = root.querySelector(".hd-now"); if (!n || !n.isConnected) { clearInterval(root0.__hdTimer); return; } n.textContent = hhmm(new Date()); }, 15000);

