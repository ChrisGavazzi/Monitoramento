/* ACESSOS VPN - Business Text (afterRender)
 * Query T (Text): item "OpenVPN: dados (JSON)" do pfSense, gerado pelo coletor zbx_ovpn.php (cron a cada 2 min).
 * Query F: problemas do pfSense com a tag component: vpn.
 * Layout: indicadores · segurança (tentativas de login na VPN, no webGUI e no SSH, mudanças de configuração) ·
 *         usuários (busca e filtros) + conectados agora, servidores e túneis, última conexão, certificados.
 * O coletor só vê a última conexão a partir do dia em que entrou no ar (historico_desde): enquanto o histórico tiver
 * menos de HIST_OK_D dias, "sem conexão" quer dizer "não conectou desde que o coletor começou", não "nunca conectou".
 */
const CERT_AVISO_D = 30, HIST_OK_D = 45, COLETOR_ATRASO_MIN = 10;

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
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const vals = f => !f ? [] : (Array.isArray(f.values) ? f.values : (f.values && f.values.toArray ? f.values.toArray() : []));

/* --- leitura --- */
let J = null, problems = [];
for (const fr of series) for (const f of fr.fields || []) {
  const v = vals(f);
  if (fr.refId === "F") { if (v.length && typeof v[0] === "object" && v[0]) problems = problems.concat(v); continue; }
  for (let i = v.length - 1; i >= 0; i--) {
    if (typeof v[i] !== "string" || v[i].charAt(0) !== "{") continue;
    try { const o = JSON.parse(v[i]); if (o && o.ts && (!J || o.ts > J.ts)) J = o; } catch (e) {}
    break;
  }
}
const S = window.__vpnState = window.__vpnState || { filtro: "todos", busca: "", ord: "ultima" };

const DIA = 86400, agora = Math.floor(Date.now() / 1000);
const dd = t => t ? new Date(t * 1000).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";
const hm = t => new Date(t * 1000).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const dur = s => { const m = Math.max(0, Math.round(s / 60)); if (m < 60) return m + " min"; const h = Math.floor(m / 60); if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}`;
  const d = Math.floor(h / 24); return d < 60 ? `${d} d` : d < 730 ? `${Math.round(d / 30)} meses` : `${(d / 365).toFixed(1).replace(".", ",")} anos`; };
const bytes = b => b == null ? "—" : b < 1e6 ? (b / 1e3).toFixed(0) + " KB" : b < 1e9 ? (b / 1e6).toFixed(1) + " MB" : (b / 1e9).toFixed(2) + " GB";
const pill = (cls, t) => `<span class="vp-pill ${cls}">${esc(t)}</span>`;
const kpi = (l, v, s, cls, tt) => `<div class="kpi ${cls || ""}"${tt ? ` title="${esc(tt)}"` : ""}><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;

function desenhar() {
  if (!J) { root.innerHTML = `<div class="vp-vazio"><b>Sem dados do coletor da VPN</b><span>O item "OpenVPN: dados (JSON)" do ${esc(NOC.vpn_host || "firewall")} não voltou. Confira o agendamento (Services → Cron) no pfSense e o arquivo /usr/local/zbx_ovpn/ovpn.json.</span></div>`; return; }
  const ref = J.ts, histD = Math.floor((ref - (J.historico_desde || ref)) / DIA), histOk = histD >= HIST_OK_D;
  const desdeTxt = dd(J.historico_desde);
  const srvCert = {};   // servidores que aceitam o certificado do usuário (quando ele ainda não conectou)
  (J.certificados || []).forEach(c => { if (c.tipo === "usuario" && !c.revogado) srvCert[c.usuario] = (srvCert[c.usuario] || []).concat(c.servidores || []); });
  const U = (J.usuarios || []).map(u => {
    const d = u.on ? 0 : u.ultima ? Math.floor((ref - u.ultima) / DIA) : null;
    const cd = u.cert_vence ? Math.floor((u.cert_vence - ref) / DIA) : null;
    let sit, cls, ord;
    if (u.desabilitado) { sit = "desabilitado"; cls = "mute"; ord = 6; }
    else if (cd != null && cd < 0) { sit = "certificado vencido"; cls = "crit"; ord = 0; }
    else if (cd != null && cd <= CERT_AVISO_D) { sit = `certificado vence em ${cd} d`; cls = "warn"; ord = 1; }
    else if (u.on) { sit = "conectado"; cls = "ok"; ord = 2; }
    else if (d == null) { sit = histOk ? "sem conexão no histórico" : `sem conexão desde ${desdeTxt}`; cls = "mute"; ord = 5; }
    else if (d >= 45) { sit = "inativo · revisar acesso"; cls = "crit"; ord = 3; }
    else if (d >= 21) { sit = "pouco uso"; cls = "warn"; ord = 4; }
    else { sit = "ativo"; cls = "ok"; ord = 4; }
    return Object.assign({}, u, { dias: d, cdias: cd, sit, cls, ordSit: ord });
  });
  const on = U.filter(u => u.on).sort((a, b) => (a.desde || 0) - (b.desde || 0));
  const h24 = U.filter(u => u.on || (u.ultima && ref - u.ultima < DIA)).length;
  const d7 = U.filter(u => u.on || (u.ultima && ref - u.ultima < 7 * DIA)).length;
  const inat = U.filter(u => !u.desabilitado && u.dias != null && u.dias >= 45).length;
  const semReg = U.filter(u => u.dias == null).length;

  const C = (J.certificados || []).filter(c => !c.revogado).map(c => Object.assign({}, c, { dias: Math.floor((c.vence - ref) / DIA) }));
  const CU = C.filter(c => c.tipo === "usuario"), CI = C.filter(c => c.tipo !== "usuario").sort((a, b) => a.dias - b.dias);
  const cVence = C.filter(c => c.dias >= 0 && c.dias <= CERT_AVISO_D).length, cVencido = C.filter(c => c.dias < 0).length;
  const prox = C.slice().sort((a, b) => a.vence - b.vence)[0];
  const SV = (J.servidores || []).filter(s => !s.desabilitado);
  const acesso = SV.filter(s => s.tipo !== "site"), tuneis = SV.filter(s => s.tipo === "site");
  const svFora = SV.filter(s => !s.no_ar), tunOk = tuneis.filter(s => s.pares && s.pares.length).length;
  const atrasoMin = Math.round((agora - ref) / 60);
  const pv = problems.filter(p => p.suppressed != 1 && p.suppressed !== "1");

  /* tabela de usuários: filtros, busca e ordem */
  const FILTROS = [
    ["todos", "Todos", () => true],
    ["on", "Conectados", u => u.on],
    ["d7", "Usaram em 7 dias", u => u.on || (u.ultima && ref - u.ultima < 7 * DIA)],
    ["inat", "Inativos 45+ dias", u => !u.desabilitado && u.dias != null && u.dias >= 45],
    ["sem", histOk ? "Sem conexão" : `Sem conexão desde ${desdeTxt.slice(0, 5)}`, u => u.dias == null],
    ["cert", `Certificado ≤ ${CERT_AVISO_D} d`, u => u.cdias != null && u.cdias <= CERT_AVISO_D],
    ["local", "Locais", u => u.origem === "local"],
    ["des", "Desabilitados", u => u.desabilitado],
  ];
  const fA = FILTROS.find(f => f[0] === S.filtro) || FILTROS[0];
  const q = (S.busca || "").trim().toLowerCase();
  const ORD = { ultima: (a, b) => (b.on - a.on) || ((b.ultima || 0) - (a.ultima || 0)) || a.u.localeCompare(b.u),
                nome: (a, b) => a.u.localeCompare(b.u), sit: (a, b) => (a.ordSit - b.ordSit) || a.u.localeCompare(b.u),
                cert: (a, b) => ((a.cdias ?? 1e9) - (b.cdias ?? 1e9)) || a.u.localeCompare(b.u) };
  const lista = U.filter(fA[2]).filter(u => !q || u.u.toLowerCase().includes(q) || (u.srv || []).join(" ").toLowerCase().includes(q) || [...(u.ip || []), ...(u.ips_recentes || []).map(x => x.ip)].join(" ").includes(q)).sort(ORD[S.ord] || ORD.ultima);
  // IP público: o atual de quem está conectado; para quem saiu, o último que o coletor viu (guardado no estado, não depende do log)
  const ipTxt = u => { const cur = (u.ip || [])[0], ip = cur || u.ip_ultimo; if (!ip) return `<span class="mute">—</span>`;
    const rec = (u.ips_recentes || []).map(x => `${x.ip}   ${dd(x.ts).slice(0, 5)} ${hm(x.ts)}`).join("\n");
    return `<span class="mono ${cur ? "" : "mute"}" title="${esc(rec ? "IPs recentes:\n" + rec : ip)}">${esc(ip)}</span>`; };
  const ultTxt = u => u.on ? `<b class="ok">agora</b>` : u.ultima ? `${dur(ref - u.ultima)} atrás <small>${dd(u.ultima).slice(0, 5)} ${hm(u.ultima)}</small>` : `<span class="mute">—</span>`;
  const th = (k, t, cls) => `<th class="${cls || ""} vp-ord${S.ord === k ? " on" : ""}" data-vo="${k}">${t}${S.ord === k ? " ▾" : ""}</th>`;

  /* faixas (só quem tem registro) */
  const FX = [["Hoje", u => u.on || (u.ultima && ref - u.ultima < DIA), "ok"], ["1 – 7 dias", u => u.dias != null && u.dias >= 1 && u.dias <= 7 && !u.on && !(ref - u.ultima < DIA), "acc"],
    ["8 – 20 dias", u => u.dias >= 8 && u.dias <= 20, "acc"], ["21 – 44 dias", u => u.dias >= 21 && u.dias <= 44, "warn"], ["45+ dias", u => u.dias != null && u.dias >= 45, "crit"],
    [histOk ? "Sem conexão" : "Sem registro ainda", u => u.dias == null, "mute"]].map(([l, f, c]) => [l, U.filter(f).length, c]);
  const maxF = Math.max(...FX.map(x => x[1]), 1);

  const svLinha = s => { const site = s.tipo === "site", ok = s.no_ar, par = site && s.pares && s.pares.length;
    const st = !ok ? pill("crit", "parado") : site ? pill(par ? "ok" : "mute", par ? "conectado" : "aguardando") : `<b class="vp-n${s.conectados ? " ok" : ""}">${s.conectados}</b>`;
    const det = site ? (par ? s.pares.join(", ") : "ninguém do outro lado") : (s.auth || []).join(" + ") || "certificado";
    return `<tr title="${esc(det)}"><td><i class="vp-dot ${!ok ? "crit" : site && !par ? "mute" : "ok"}"></i>${esc(s.nome)}${s.modo === "server_user" ? ' <span class="vp-tag warn" title="Só usuário e senha, sem certificado do usuário">só senha</span>' : ""}
</td><td class="mono">${esc(s.porta)}/${esc((s.proto || "").replace(/[46]$/, "").toLowerCase())}</td><td class="n">${st}</td></tr>`; };

  /* segurança: tentativas de login e mudanças de configuração (últimas 24 h) */
  const SG = J.seguranca || null;
  const contas = new Set(U.map(u => u.u.toLowerCase()));
  const nomeSv = {}; SV.forEach(s => { nomeSv[s.nome] = s; });
  const n0 = v => v || 0;
  const ipUser = {}; on.forEach(u => (u.ip || []).forEach(i => { ipUser[i] = u.u; }));
  const boxOn = `<div class="box vp-on"><h2><span>Conectados agora</span><span class="c ${on.length ? "z" : "mute"}">${on.length}</span></h2>
        ${on.length ? `<div class="vp-scroll s4"><table class="vp-t"><tbody>${on.map(u => `<tr title="${esc(`IP na VPN: ${(u.vip || []).join(", ") || "—"} · recebido ${bytes(u.tx)} · enviado ${bytes(u.rx)}`)}">
          <td><i class="vp-dot ok"></i><b>${esc(u.u)}</b></td><td class="mute">${esc((u.srv || []).join(", "))}</td><td class="n">${u.desde ? dur(ref - u.desde) : "—"}</td><td class="mono n">${esc((u.ip || [])[0] || "")}</td></tr>`).join("")}</tbody></table></div>`
          : `<div class="vp-nada">Ninguém conectado nas VPNs de acesso.</div>`}</div>`;
  let cfgHtml = "";
  let segHtml = "";
  if (!SG) segHtml = `<div class="vp-seg vp-seg2"><div class="vp-aviso">Tentativas de login e mudanças de configuração aparecem aqui depois que o coletor for atualizado no pfSense (versão com "seguranca" no JSON).</div>${boxOn}</div>`;
  else {
    const V = SG.vpn || {}, G = SG.gui || {}, H = SG.ssh || {}, CF = SG.config || {};
    const cob = Math.round((ref - (SG.cobre_desde || ref)) / 3600);
    const cobTxt = cob < 23 ? ` <span class="vp-tag warn" title="Os logs do pfSense só guardam ${cob} h: o resto já foi rodado">logs: ${cob} h</span>` : "";
    const pSrv = (V.por_srv || []).filter(x => x.falhas_24h || x.ruido_24h).sort((a, b) => (b.falhas_24h - a.falhas_24h) || (b.ruido_24h - a.ruido_24h));
    const vCls = n0(V.recusados_1h) + n0(V.falhas_1h) >= 20 ? "crit" : n0(V.recusados_24h) + n0(V.falhas_24h) ? "warn" : "z";
    const ipL = (arr, k) => (arr || []).slice(0, k).map(x => `<span class="vp-ip" title="${x.n} tentativa(s)${x.srv ? " · " + esc(x.srv) : ""}"><span class="mono">${esc(x.ip)}</span> <b>${x.n}</b>${ipUser[x.ip] ? ` <small class="vp-who" title="Este IP é de ${esc(ipUser[x.ip])}, conectado agora">↳ ${esc(ipUser[x.ip])}</small>` : ""}</span>`).join("") || `<span class="mute">nenhum</span>`;
    const uL = (arr, k) => (arr || []).slice(0, k).map(x => { const real = contas.has(String(x.u).toLowerCase());
      return `<span class="vp-u${real ? " real" : ""}" title="${real ? "Conta que existe na VPN: alvo real" : "Usuário que não existe aqui: robô chutando nomes"}">${esc(x.u)} <b>${x.n}</b></span>`; }).join("") || `<span class="mute">nenhum</span>`;
    const lin = (l, v, cls) => `<div class="vp-sl"><span>${l}</span><b class="${cls || ""}">${v}</b></div>`;
    const rec1 = Math.max(n0(V.recusados_1h), n0(V.falhas_1h)), rec24 = Math.max(n0(V.recusados_24h), n0(V.falhas_24h));
    const gCls = n0(G.falhas_24h) ? "warn" : "", hCls = n0(H.falhas_24h) ? "crit" : "";
    const mud = CF.lista || [];
    const ult = mud[0];
    cfgHtml = `<details class="vp-cfg"${S.cfgAberto ? " open" : ""}><summary>Mudanças de configuração: <b>${n0(CF.mudancas_24h)} em 24 h</b>${ult ? ` · última: ${esc(ult.por || "?")}${ult.ts ? ` em ${dd(ult.ts).slice(0, 5)} ${hm(ult.ts)}` : ""}` : ""}</summary>
      <div class="vp-scroll s5"><table class="vp-t vp-mud"><tbody>
      ${mud.map(m => `<tr title="${esc(m.desc)}"><td class="mute">${m.ts ? `${dd(m.ts).slice(0, 5)} ${hm(m.ts)}` : "—"}</td>
        <td class="${m.por === "(system)" ? "mute" : ""}">${esc(m.por || "?")}${m.ip ? ` <small class="mono">${esc(m.ip)}</small>` : ""}</td><td class="vp-md">${esc(m.desc)}</td></tr>`).join("")
        || `<tr><td class="vp-nada">Sem histórico.</td></tr>`}
      </tbody></table></div>
      <div class="vp-nota">Mesmo histórico de Diagnostics → Backup &amp; Restore → Config History (lá dá para ver o diff e desfazer).</div></details>`;
    segHtml = `<div class="vp-seg">
      <div class="box"><h2><span>Tentativas na VPN <span class="mute">24 h</span>${cobTxt}</span><span class="c ${rec24 ? (rec1 >= 20 ? "crit" : "warn") : "z"}">${rec1 ? `${rec1} recusada${rec1 === 1 ? "" : "s"} na última hora` : "sem recusas na última hora"}</span></h2>
        <div class="vp-sb">
          <div class="vp-tiles">
            <div class="vp-tile" title="Login recusado: senha errada, usuário que não existe ou falha registrada pelo servidor OpenVPN. O mesmo login pode aparecer nos dois registros, por isso conta o maior."><div class="h"><span class="l">Recusadas</span><span class="v ${rec24 ? "warn" : ""}">${rec24}</span></div><div class="s">${rec1} na última hora</div></div>
            <div class="vp-tile" title="Autenticações aceitas no log. Inclui a renovação de chave de quem já está conectado, então não é o número de conexões."><div class="h"><span class="l">Aceitas</span><span class="v">${n0(V.ok_24h)}</span></div><div class="s">inclui renovação de chave</div></div>
            <div class="vp-tile" title="Pacotes que o servidor descartou antes de qualquer login (HMAC ou TLS inválido): cliente com perfil velho, rede ruim ou varredura."><div class="h"><span class="l">Pacotes inválidos</span><span class="v">${n0(V.ruido_24h)}</span></div><div class="s">barrados antes do login</div></div>
          </div>
          ${pSrv.length ? `<table class="vp-srvt"><thead><tr><th>Por servidor</th><th title="Falha de login registrada pelo servidor OpenVPN">Login falhou</th><th title="Pacote barrado antes do login (HMAC/TLS)">Pacote inválido</th></tr></thead><tbody>${pSrv.slice(0, 4).map(x => { const sv = nomeSv[x.nome];
            return `<tr><td>${esc(x.nome)}${sv && sv.modo === "server_user" ? ' <span class="vp-tag warn">só senha</span>' : ""}</td><td class="n ${x.falhas_24h ? "warn" : "mute"}">${x.falhas_24h}</td><td class="n mute">${x.ruido_24h}</td></tr>`; }).join("")}</tbody></table>` : ""}
          ${(V.u || []).length ? `<div class="vp-lr"><span class="vp-lb" title="Contas que tentaram entrar. Vermelho = a conta existe (erro de digitação ou alvo real)">Contas</span><div class="vp-chs">${uL(V.u, 6)}</div></div>` : ""}
          ${(V.ip || []).length ? `<div class="vp-lr"><span class="vp-lb" title="IPs de origem dos logins recusados">IPs login recusado</span><div class="vp-chs">${ipL(V.ip, 4)}</div></div>` : ""}
          ${(V.ip_ruido || []).length ? `<div class="vp-lr"><span class="vp-lb" title="IPs de origem dos pacotes barrados antes do login">IPs pacote inválido</span><div class="vp-chs">${ipL(V.ip_ruido, 3)}</div></div>` : ""}
          ${n0(V.dessinc_24h) ? `<div class="vp-nota2" title="Mensagens do log: TLS keys out of sync e AEAD Decrypt error. O pico é a hora com mais ocorrências nas últimas 24 h.">Chaves fora de sincronia: <b>${V.dessinc_24h}</b> em 24 h${n0(V.dessinc_pico) ? ` · pico de ${V.dessinc_pico} às ${hm(V.dessinc_pico_ts).slice(0, 2)}h` : ""}</div>` : ""}
        </div></div>
      <div class="box"><h2><span>Logins no firewall <span class="mute">24 h</span></span><span class="c ${n0(H.falhas_24h) ? "" : n0(G.falhas_24h) ? "warn" : "z"}">${n0(G.falhas_24h) + n0(H.falhas_24h)} falha(s)</span></h2>
        <div class="vp-sb">
          <div class="vp-st">webGUI (porta 4443, só IPs confiáveis)</div>
          ${lin("Falhas", `${n0(G.falhas_1h)} <small>1 h</small> · ${n0(G.falhas_24h)} <small>24 h</small>`, gCls)}
          ${lin("Logins aceitos", `${n0(G.ok_24h)} <small>24 h</small>`)}
          ${(G.ip || []).length ? `<div class="vp-chs">${ipL(G.ip, 4)}</div>` : ""}
          <div class="vp-st">SSH (só pela VPN)</div>
          ${lin("Falhas", `${n0(H.falhas_1h)} <small>1 h</small> · ${n0(H.falhas_24h)} <small>24 h</small>`, hCls)}
          ${lin("Logins aceitos", `${n0(H.ok_24h)} <small>24 h</small>`)}
          ${lin("IPs bloqueados pelo sshguard", `${n0(H.bloqueios_24h)} <small>24 h</small>`, n0(H.bloqueios_24h) ? "warn" : "")}
          ${(H.ip || []).length ? `<div class="vp-chs">${ipL(H.ip, 4)}</div>` : ""}
        </div></div>
      ${boxOn}
    </div>`;
  }

  root.innerHTML = `
  ${atrasoMin > COLETOR_ATRASO_MIN ? `<div class="vp-aviso crit">Coletor parado: último dado de ${dd(ref)} ${hm(ref)} (${dur(agora - ref)} atrás).</div>` : ""}
  ${!histOk ? `<div class="vp-aviso">Histórico de conexões desde <b>${desdeTxt}</b> (${histD} dia${histD === 1 ? "" : "s"}). Dias sem conexão e inativos só ficam confiáveis depois de ${HIST_OK_D} dias: até lá, "sem conexão" quer dizer "não conectou desde ${desdeTxt}". Usuários do AD aparecem na primeira conexão.</div>` : ""}
  <section class="vp-kpis">
    ${kpi("Conectados agora", on.length, `${acesso.length} servidores de acesso`, on.length ? "ok" : "")}
    ${kpi("Usaram hoje", h24, `${d7} nos últimos 7 dias`, "")}
    ${kpi("Usuários", U.length, `${U.filter(u => u.origem === "local").length} locais · ${U.filter(u => u.origem !== "local").length} AD ou só certificado`, "")}
    ${kpi("Inativos 45+ dias", histOk ? inat : "—", histOk ? "revisar acesso" : `histórico com ${histD} d`, histOk && inat ? "crit" : "mute")}
    ${kpi(cVencido ? "Certificados vencidos" : "Certificados vencendo ≤ 30 d", cVencido || cVence, prox ? `próximo: ${esc(prox.nome)} em ${dur(prox.vence - ref)}` : "—", cVencido ? "crit" : cVence ? "warn" : "ok")}
    ${kpi(svFora.length ? "Servidores parados" : "Servidores no ar", svFora.length ? `${svFora.length}/${SV.length}` : `${SV.length}/${SV.length}`, `túneis com o outro lado: ${tunOk}/${tuneis.length}`, svFora.length ? "crit" : "ok")}
  </section>
  ${segHtml}
  <div class="vp-main">
    <div class="vp-left">
    <div class="box vp-usr"><h2><span>Usuários <span class="mute">${lista.length} de ${U.length}</span></span>
      <span class="vp-ctl"><input id="vp-busca" type="search" placeholder="buscar usuário, servidor ou IP" value="${esc(S.busca || "")}"></span></h2>
      <div class="vp-chips">${FILTROS.map(f => `<button data-vf="${f[0]}" class="${f[0] === fA[0] ? "on" : ""}">${f[1]} <em>${U.filter(f[2]).length}</em></button>`).join("")}</div>
      <div class="vp-scroll s2"><table class="vp-t"><thead><tr>${th("nome", "Usuário")}<th>Origem</th><th>Servidor</th><th>Último IP</th>${th("ultima", "Última conexão")}${th("cert", "Certificado vence", "n")}${th("sit", "Situação")}</tr></thead><tbody>
      ${lista.slice(0, 300).map(u => `<tr><td>${u.on ? '<i class="vp-dot ok"></i>' : ""}${esc(u.u)}</td><td class="mute">${u.origem === "local" ? "local" : "AD / certificado"}</td>
        <td>${(u.srv || []).length ? esc(u.srv.join(", ")) : srvCert[u.u] ? `<span class="mute" title="Servidor(es) que aceitam o certificado dele">${esc([...new Set(srvCert[u.u])].join(", "))}</span>` : "—"}</td><td>${ipTxt(u)}</td><td>${ultTxt(u)}</td>
        <td class="n ${u.cdias != null && u.cdias < 0 ? "crit" : u.cdias != null && u.cdias <= CERT_AVISO_D ? "warn" : "mute"}">${u.cert_vence ? dd(u.cert_vence) : "—"}</td><td>${pill(u.cls, u.sit)}</td></tr>`).join("")
        || `<tr><td colspan="7" class="vp-nada">Nenhum usuário neste filtro${q ? " com essa busca" : ""}.</td></tr>`}
      </tbody></table></div></div>
    ${cfgHtml}
    </div>
    <div class="vp-col">
      <div class="box"><h2>Servidores e túneis ${svFora.length ? `<span class="c">${svFora.length} parado(s)</span>` : `<span class="c z">${SV.length} no ar</span>`}</h2>
        <table class="vp-t"><tbody>
        <tr class="vp-sub"><td colspan="3">Acesso remoto · ${acesso.length}</td></tr>${acesso.map(svLinha).join("")}
        <tr class="vp-sub"><td colspan="3">Túneis entre sites · ${tuneis.length}</td></tr>${tuneis.map(svLinha).join("")}
        </tbody></table></div>
      <div class="box"><h2>Última conexão <span class="mute">${U.length} usuários</span></h2>
        <div class="vp-stack">${FX.filter(x => x[1]).map(([l, n, c]) => `<b class="${c}" style="flex:${n}" title="${esc(l)}: ${n}"></b>`).join("")}</div>
        <div class="vp-leg">${FX.map(([l, n, c]) => `<span class="${n ? "" : "z"}"><i class="${c}"></i>${l} <b>${n}</b></span>`).join("")}</div>
        ${!histOk ? `<div class="vp-nota">Histórico com ${histD} dia(s): ainda há muitos "sem registro".</div>` : ""}</div>
      <div class="box"><h2>Certificados da infraestrutura <span class="c ${CI.some(c => c.dias <= CERT_AVISO_D) ? "" : "z"}">${CI.length}</span></h2>
        <table class="vp-t"><tbody>
        ${(S.certTodos ? CI : CI.slice(0, 5)).map(c => `<tr title="${esc((c.servidores || []).join(", "))}"><td>${pill(c.tipo === "ca" ? "acc" : "mute", c.tipo === "ca" ? "CA" : c.tipo === "par" ? "túnel" : "servidor")} ${esc(c.nome)}</td>
          <td class="n ${c.dias < 0 ? "crit" : c.dias <= CERT_AVISO_D ? "warn" : "mute"}">${dd(c.vence)}</td></tr>`).join("")}
        </tbody></table>
        <div class="vp-nota">${CI.length > 5 ? `<button class="vp-link" data-vc="1">${S.certTodos ? "mostrar só os 5 primeiros" : `mostrar todos (${CI.length})`}</button> · ` : ""}${CU.length} de usuário · ${CU.filter(c => c.dias <= CERT_AVISO_D).length} vencendo ou vencidos</div></div>
      ${pv.length ? `<div class="box vp-alertas"><h2>Alertas da VPN <span class="c">${pv.length}</span></h2>${pv.slice(0, 5).map(p => `<div>${esc(p.name || p.description || "")}</div>`).join("")}</div>` : ""}
    </div>
  </div>
  <div class="vp-rod">Coletado às ${hm(ref)} de ${dd(ref)} · pfSense ${esc(NOC.vpn_host || "")} · ↓ / ↑ = recebido / enviado pelo usuário nesta conexão</div>`;

  root.querySelectorAll("[data-vf]").forEach(b => b.addEventListener("click", () => { S.filtro = b.dataset.vf; desenhar(); }));
  root.querySelectorAll("[data-vo]").forEach(b => b.addEventListener("click", () => { S.ord = b.dataset.vo; desenhar(); }));
  root.querySelectorAll("[data-vc]").forEach(b => b.addEventListener("click", () => { S.certTodos = !S.certTodos; desenhar(); }));
  const dc = root.querySelector(".vp-cfg"); if (dc) dc.addEventListener("toggle", () => { S.cfgAberto = dc.open; });
  const inp = root.querySelector("#vp-busca");
  if (inp) {
    inp.addEventListener("input", () => { S.busca = inp.value; S.foco = true; desenhar(); });
    if (S.foco) { inp.focus(); const n = inp.value.length; try { inp.setSelectionRange(n, n); } catch (e) {} S.foco = false; }
  }
}
desenhar();

