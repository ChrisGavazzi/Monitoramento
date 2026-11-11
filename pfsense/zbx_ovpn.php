<?php
/*
 * Coletor de acessos OpenVPN para o Zabbix (pfSense 2.7.x). SÓ LÊ: não muda configuração, não derruba ninguém.
 *
 * O que faz a cada execução (cron do pfSense, como root, a cada 2 min):
 *   1. lê os servidores OpenVPN da configuração e quem está conectado agora (socket de gerência de cada servidor);
 *   2. lê os certificados usados pelo OpenVPN (CA, certificado do servidor, certificados de usuário) e a data de vencimento;
 *   3. guarda, num arquivo de estado, a última vez que cada usuário foi visto conectado;
 *   4. lê os logs das últimas 24 h: falhas de login na VPN (por servidor), no webGUI e no SSH, bloqueios do sshguard;
 *   5. lê o histórico de mudanças de configuração (o mesmo de Diagnostics > Backup & Restore > Config History);
 *   6. grava o resultado em JSON, que o agente Zabbix lê com vfs.file.contents.
 *
 * Arquivos (pasta persistente, fora de /tmp e /var, que podem ser RAM disk):
 *   /usr/local/zbx_ovpn/ovpn.json    resultado (lido pelo Zabbix)
 *   /usr/local/zbx_ovpn/estado.json  última conexão de cada usuário (NÃO apague: é o histórico de "dias sem conexão")
 *
 * Uso:
 *   php -q /usr/local/zbx_ovpn/zbx_ovpn.php            coleta e grava (é o que o cron roda)
 *   php -q /usr/local/zbx_ovpn/zbx_ovpn.php --resumo   só mostra contagens e nomes de campos, sem usuários, sem gravar
 *   php -q /usr/local/zbx_ovpn/zbx_ovpn.php --diag     mostra o que foi reconhecido nos logs (IPs e usuários mascarados), sem gravar
 *
 * Usuários do AD/LDAP não existem no pfSense: só aparecem depois de conectar pela primeira vez com o coletor rodando.
 * "Nunca conectou" vale para usuários locais e para certificados de usuário que nunca foram usados.
 */
require_once("config.inc");
require_once("certs.inc");
require_once("openvpn.inc");

const DIR = "/usr/local/zbx_ovpn";
$RESUMO = in_array("--resumo", $argv ?? []);
$DIAG = in_array("--diag", $argv ?? []);
$agora = time();

function cfg($path, $def = []) {
	if (function_exists("config_get_path")) { $v = config_get_path($path, $def); return is_array($v) ? $v : $def; }
	global $config; $v = $config; foreach (explode("/", $path) as $k) { if (!is_array($v) || !isset($v[$k])) return $def; $v = $v[$k]; }
	return is_array($v) ? $v : $def;
}
function lista($v) { return (is_array($v) && isset($v[0])) || $v === [] ? $v : [$v]; }   // item único no config.xml vem sem índice
function certinfo($crt) {
	$x = @openssl_x509_parse(base64_decode($crt));
	if (!$x) return null;
	return ["cn" => $x["subject"]["CN"] ?? "", "exp" => (int)($x["validTo_time_t"] ?? 0), "ini" => (int)($x["validFrom_time_t"] ?? 0)];
}

/* --- configuração --- */
$srvcfg = lista(cfg("openvpn/openvpn-server"));
$certs = []; foreach (lista(cfg("cert")) as $c) if (!empty($c["refid"])) $certs[$c["refid"]] = $c;
$cas = []; foreach (lista(cfg("ca")) as $c) if (!empty($c["refid"])) $cas[$c["refid"]] = $c;
$revog = []; foreach (lista(cfg("crl")) as $crl) foreach (lista($crl["cert"] ?? []) as $rc) if (!empty($rc["refid"])) $revog[$rc["refid"]] = true;
$locais = [];
foreach (lista(cfg("system/user")) as $u) {
	if (empty($u["name"])) continue;
	$locais[$u["name"]] = ["disabled" => isset($u["disabled"]), "expires" => !empty($u["expires"]) ? strtotime($u["expires"]) : null,
	                       "certs" => array_values(array_filter(lista($u["cert"] ?? [])))];
}

/* --- quem está conectado agora --- */
$ativos = [];
foreach ((array)openvpn_get_active_servers() as $s) $ativos[(string)($s["vpnid"] ?? "")] = $s;

$servidores = []; $vpnCAs = []; $caAcesso = []; $srvCert = []; $online = [];
foreach ($srvcfg as $s) {
	$id = (string)($s["vpnid"] ?? ""); $nome = $s["description"] ?? ("server" . $id);
	$a = $ativos[$id] ?? null; $conns = $a ? lista($a["conns"] ?? []) : [];
	$conns = array_values(array_filter($conns, fn($c) => is_array($c) && !empty($c["common_name"] ?? $c["user_name"] ?? null)));
	$auth = array_values(array_filter(explode(",", $s["authmode"] ?? "")));
	$site = strpos($s["mode"] ?? "", "p2p") === 0;   // ponto a ponto = túnel entre sites (ex.: a RB da sede), não usuário
	$pares = $site ? array_values(array_unique(array_map(fn($c) => $c["common_name"] ?? "?", $conns))) : [];
	$servidores[] = ["id" => $id, "nome" => $nome, "modo" => $s["mode"] ?? "", "tipo" => $site ? "site" : "acesso", "porta" => $s["local_port"] ?? "", "proto" => $s["protocol"] ?? "",
	                 "auth" => $auth, "desabilitado" => isset($s["disable"]), "pares" => $pares,
	                 "no_ar" => !isset($s["disable"]) && (file_exists("/var/etc/openvpn/server{$id}/sock") || count($conns) > 0), "conectados" => count($conns)];
	if (!empty($s["caref"])) { $vpnCAs[$s["caref"]][] = $nome; if (!$site) $caAcesso[$s["caref"]] = true; }
	if (!empty($s["certref"])) $srvCert[$s["certref"]][] = $nome;
	if ($site) continue;   // conexão de túnel não entra como usuário
	foreach ($conns as $c) {
		$u = $c["user_name"] ?? ""; if ($u === "" || $u === "UNDEF") $u = $c["common_name"] ?? "?";
		$desde = (int)($c["connect_time_unix"] ?? 0) ?: (int)@strtotime($c["connect_time"] ?? "");
		$o = &$online[$u]; $o = $o ?? ["srv" => [], "desde" => $desde ?: $agora, "ip" => [], "vip" => [], "rx" => 0, "tx" => 0];
		if (!empty($c["virtual_addr"])) $o["vip"][] = $c["virtual_addr"];
		$o["rx"] += (int)($c["bytes_recv"] ?? 0); $o["tx"] += (int)($c["bytes_sent"] ?? 0);
		$o["srv"][] = $nome; $o["desde"] = min($o["desde"], $desde ?: $agora);
		$ip = preg_replace('/:\d+$/', '', (string)($c["remote_host"] ?? $c["real_address"] ?? "")); if ($ip !== "") $o["ip"][] = $ip;
		unset($o);
	}
}

/* --- certificados do OpenVPN: CA dos servidores, certificado de cada servidor, certificados de usuário assinados por essas CAs --- */
$lista_c = []; $dono = [];
foreach ($locais as $n => $u) foreach ($u["certs"] as $r) $dono[$r] = $n;
foreach ($vpnCAs as $ref => $srvs) { $ca = $cas[$ref] ?? null; $i = $ca ? certinfo($ca["crt"] ?? "") : null;
	if ($i) $lista_c[] = ["ref" => $ref, "tipo" => "ca", "nome" => $ca["descr"] ?? $i["cn"], "cn" => $i["cn"], "vence" => $i["exp"], "servidores" => $srvs, "revogado" => false]; }
foreach ($srvCert as $ref => $srvs) { $c = $certs[$ref] ?? null; $i = $c ? certinfo($c["crt"] ?? "") : null;
	if ($i) $lista_c[] = ["ref" => $ref, "tipo" => "servidor", "nome" => $c["descr"] ?? $i["cn"], "cn" => $i["cn"], "vence" => $i["exp"], "servidores" => $srvs, "revogado" => isset($revog[$ref])]; }
foreach ($certs as $ref => $c) {
	if (isset($srvCert[$ref]) || empty($c["caref"]) || !isset($vpnCAs[$c["caref"]])) continue;
	if (($c["type"] ?? "") === "server") continue;
	$i = certinfo($c["crt"] ?? ""); if (!$i) continue;
	$tipo = isset($caAcesso[$c["caref"]]) ? "usuario" : "par";   // CA só de túneis entre sites: certificado do outro lado do túnel
	$lista_c[] = ["ref" => $ref, "tipo" => $tipo, "nome" => $c["descr"] ?? $i["cn"], "cn" => $i["cn"], "usuario" => $dono[$ref] ?? $i["cn"], "vence" => $i["exp"],
	              "servidores" => $vpnCAs[$c["caref"]], "revogado" => isset($revog[$ref])];
}

/* --- estado: última conexão de cada usuário --- */
@mkdir(DIR, 0755, true);
$est = @json_decode(@file_get_contents(DIR . "/estado.json"), true);
if (!is_array($est) || !isset($est["usuarios"])) $est = ["desde" => $agora, "usuarios" => []];
foreach ($online as $u => $o) {
	$e = $est["usuarios"][$u] ?? ["primeira" => $agora];
	$e["ultima"] = $agora; $e["srv"] = array_values(array_unique($o["srv"]));
	$est["usuarios"][$u] = $e;
}

/* --- usuários: locais com certificado de VPN, donos de certificado de VPN, e todo mundo que já conectou --- */
$nomes = array_keys($est["usuarios"]);
foreach ($lista_c as $c) if ($c["tipo"] === "usuario" && !$c["revogado"]) $nomes[] = $c["usuario"];
$usuarios = [];
foreach (array_unique($nomes) as $n) {
	$e = $est["usuarios"][$n] ?? null; $l = $locais[$n] ?? null; $on = $online[$n] ?? null;
	$cv = array_values(array_filter($lista_c, fn($c) => $c["tipo"] === "usuario" && $c["usuario"] === $n && !$c["revogado"]));
	$usuarios[] = ["u" => $n, "origem" => $l ? "local" : "externo", "on" => $on ? 1 : 0, "desde" => $on["desde"] ?? null,
	               "ip" => $on ? array_values(array_unique($on["ip"])) : [], "vip" => $on ? array_values(array_unique($on["vip"])) : [],
	               "rx" => $on["rx"] ?? null, "tx" => $on["tx"] ?? null, "srv" => $on ? array_values(array_unique($on["srv"])) : ($e["srv"] ?? []),
	               "ultima" => $e["ultima"] ?? null, "primeira" => $e["primeira"] ?? null,
	               "desabilitado" => $l ? $l["disabled"] : false, "expira" => $l["expires"] ?? null,
	               "cert_vence" => $cv ? min(array_column($cv, "vence")) : null];
}
usort($usuarios, fn($a, $b) => strcmp($a["u"], $b["u"]));


/* --- logs das últimas 24 h: tentativas de login --- */
const JANELA = 86400; const HORA = 3600;
function linhas_log($base, $desde, &$cobre, &$lidos) {
	// arquivo atual + o rodado anterior (.0, comprimido ou não) quando o atual não cobre a janela inteira
	$arqs = [$base]; $w = stream_get_wrappers();
	foreach (["" => null, ".bz2" => "compress.bzip2://", ".gz" => "compress.zlib://"] as $ext => $wr)
		if (file_exists("$base.0$ext") && ($wr === null || in_array(rtrim($wr, ":/"), $w))) { $arqs[] = ($wr ?? "") . "$base.0$ext"; break; }
	$out = [];
	foreach ($arqs as $i => $a) {
		$fh = @fopen($a, "r"); if (!$fh) continue;
		$lidos[] = $a; $prim = null;
		while (($l = fgets($fh)) !== false) {
			$r = parse_syslog(rtrim($l, "\n")); if (!$r) continue;
			$prim = $prim ?? $r["t"];
			if ($r["t"] >= $desde) $out[] = $r;
		}
		fclose($fh);
		if ($prim !== null) $cobre = min($cobre, $prim);
		if ($i === 0 && $prim !== null && $prim <= $desde) break;   // o atual já cobre 24 h
	}
	return $out;
}
function parse_syslog($l) {
	global $agora;
	if (preg_match('/^<\d{1,3}>\d* (\S+) \S+ (\S+) (\S+) \S+ (?:-|\[.*?\]) ?(.*)$/', $l, $m)) {           // RFC 5424
		$t = strtotime($m[1]); if (!$t) return null;
		return ["t" => $t, "p" => $m[2], "pid" => $m[3] === "-" ? "" : $m[3], "m" => $m[4]];
	}
	if (preg_match('/^([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}:\d{2}:\d{2}) \S+ ([^\[: ]+)(?:\[(\d+)\])?: ?(.*)$/', $l, $m)) {   // BSD (RFC 3164): sem ano
		$t = strtotime("$m[1] $m[2] " . date("Y", $agora) . " $m[3]"); if (!$t) return null;
		if ($t > $agora + 86400) $t = strtotime("$m[1] $m[2] " . (date("Y", $agora) - 1) . " $m[3]");
		return ["t" => $t, "p" => $m[4], "pid" => $m[5] ?? "", "m" => $m[6]];
	}
	return null;
}
function ip_msg($m) { return preg_match('/^(?:\[[^\]]*\] )?([0-9a-fA-F.:]+?):\d+ /', $m, $x) ? $x[1] : ""; }   // "1.2.3.4:5678 TLS ..." ou "[cn] 1.2.3.4:5678 ..."
function nome_curto($s) { $s = preg_replace('/[^\x20-\x7E\x{00C0}-\x{017F}]/u', '?', (string)$s); return mb_substr($s, 0, 40); }
function topo($cont, $n = 10, $campo = "ip") { arsort($cont); $r = []; foreach (array_slice($cont, 0, $n, true) as $k => $v) $r[] = [$campo => (string)$k, "n" => $v]; return $r; }

$desde = $agora - JANELA; $cobre = $agora; $lidos = [];
$diag = ["reconhecidas" => [], "amostras" => [], "outras" => []];
$marca = function ($chave, $m) use (&$diag, $DIAG) {
	if (!$DIAG) return;
	$diag["reconhecidas"][$chave] = ($diag["reconhecidas"][$chave] ?? 0) + 1;
	if (count($diag["amostras"][$chave] ?? []) < 2)
		$diag["amostras"][$chave][] = preg_replace(['/\d{1,3}\.\d{1,3}\.\d{1,3}\.(\d{1,3})/', "/'[^']*'/", '/"[^"]*"/'], ['x.x.x.$1', "'…'", '"…"'], mb_substr($m, 0, 160));
};

// servidor OpenVPN de cada processo: /var/run/openvpn_server<id>.pid
$pidSrv = [];
foreach ($srvcfg as $s) { $id = (string)($s["vpnid"] ?? ""); $p = trim((string)@file_get_contents("/var/run/openvpn_server{$id}.pid")); if ($p !== "") $pidSrv[$p] = $id; }
$nomeSrv = []; foreach ($servidores as $sv) $nomeSrv[$sv["id"]] = $sv["nome"];

/* --- mapa PID -> servidor no syslog: as linhas do daemon (TLS, peer info, AEAD...) só trazem o PID, que muda a cada reinício;
       sem este registro, o log guardado por anos fica sem saber de qual servidor cada linha veio.
       Só escreve quando o mapa muda ou a cada 24 h. O nome do servidor nas linhas "connected" (ovpnsN) é o id da instância. --- */
if (!$DIAG) {
	$mapa = []; foreach ($pidSrv as $pid => $id) $mapa[(string)$pid] = (string)$id; ksort($mapa);
	$hMapa = md5(json_encode($mapa));
	if ($mapa && (($est["mapa_hash"] ?? "") !== $hMapa || $agora - (int)($est["mapa_ts"] ?? 0) > 86400)) {
		openlog("ovpn-map", LOG_PID, LOG_USER);
		foreach ($mapa as $pid => $id) syslog(LOG_NOTICE, sprintf('pid=%s server=ovpns%s name="%s"', $pid, $id, $nomeSrv[$id] ?? "?"));
		closelog();
		$est["mapa_hash"] = $hMapa; $est["mapa_ts"] = $agora;
	}
}

$RX_FALHA = '/Auth Username\/Password verification failed|AUTH_FAILED|auth-failure|authentication failed|Username does not match certificate/i';
$RX_DESSINC = '/TLS keys are out of sync|AEAD Decrypt error/i';   // chaves dessincronizadas: pico após reinício da instância ou cliente com sessão velha
$RX_RUIDO = '/TLS handshake failed|TLS key negotiation failed|HMAC authentication failed|cannot locate HMAC|tls-crypt unwrap|incoming packet authentication failed|Bad encapsulated packet length|Non-OpenVPN client protocol|VERIFY ERROR|certificate verify failed/i';
$vpn = ["falhas_1h" => 0, "falhas_24h" => 0, "recusados_1h" => 0, "recusados_24h" => 0, "ruido_24h" => 0, "dessinc_1h" => 0, "dessinc_24h" => 0, "dessinc_pico" => 0, "dessinc_pico_ts" => 0, "ok_24h" => 0, "por_srv" => [], "ip" => [], "ip_ruido" => [], "u" => []];
$dessH = [];
$conIp = [];   // usuário => [ip público => última vez visto], lido das linhas "connected" do log
$srvSeg = [];
foreach (linhas_log("/var/log/openvpn.log", $desde, $cobre, $lidos) as $r) {
	if ($r["p"] !== "openvpn") continue;
	$m = $r["m"]; $h = $r["t"] >= $agora - HORA;
	if (preg_match("/^user '(.*)' could not authenticate/", $m, $x)) {        // script de autenticação do pfSense: tem o usuário, não tem IP nem servidor
		$vpn["u"][nome_curto($x[1])] = ($vpn["u"][nome_curto($x[1])] ?? 0) + 1; $vpn["recusados_24h"]++; if ($h) $vpn["recusados_1h"]++;
		$marca("vpn: usuário recusado", $m); continue;
	}
	if (preg_match("/^user '(.*)' authenticated/", $m)) { $vpn["ok_24h"]++; $marca("vpn: usuário aceito", $m); continue; }
	if (preg_match("/^openvpn server '[^']*' user '(.*)' address '([^']*)' - connected\\b/", $m, $x)) {     // única linha do log com usuário e IP público juntos
		$ipc = preg_replace('/:\\d+$/', '', $x[2]);
		if ($ipc !== "" && $x[1] !== "UNDEF") $conIp[$x[1]][$ipc] = max($conIp[$x[1]][$ipc] ?? 0, $r["t"]);
		$marca("vpn: conexão estabelecida", $m); continue;
	}
	$sid = $pidSrv[$r["pid"]] ?? "?";
	if (preg_match($RX_DESSINC, $m)) {
		$vpn["dessinc_24h"]++; if ($h) $vpn["dessinc_1h"]++;
		$hb = intdiv($r["t"], HORA); $dessH[$hb] = ($dessH[$hb] ?? 0) + 1;
		$marca("vpn: chaves fora de sincronia / AEAD", $m); continue;
	}
	if (preg_match($RX_RUIDO, $m)) {
		$e = &$srvSeg[$sid]; $e = $e ?? ["falhas_1h" => 0, "falhas_24h" => 0, "ruido_24h" => 0];
		$e["ruido_24h"]++; $vpn["ruido_24h"]++; unset($e);
		$ip = ip_msg($m); if ($ip !== "") { $k = "$ip|$sid"; $vpn["ip_ruido"][$k] = ($vpn["ip_ruido"][$k] ?? 0) + 1; }
		$marca("vpn: pacote rejeitado (HMAC/TLS)", $m); continue;
	}
	if (preg_match($RX_FALHA, $m)) {
		$e = &$srvSeg[$sid]; $e = $e ?? ["falhas_1h" => 0, "falhas_24h" => 0, "ruido_24h" => 0];
		$e["falhas_24h"]++; $vpn["falhas_24h"]++; if ($h) { $e["falhas_1h"]++; $vpn["falhas_1h"]++; } unset($e);
		$ip = ip_msg($m); if ($ip !== "") { $k = "$ip|$sid"; $vpn["ip"][$k] = ($vpn["ip"][$k] ?? 0) + 1; }
		$marca("vpn: falha de autenticação (servidor)", $m); continue;
	}
	if ($DIAG) { $f = preg_replace(['/[0-9a-fA-F]*[.:][0-9a-fA-F.:]+/', '/\d+/', "/'[^']*'/", '/"[^"]*"/'], ['IP', 'N', "'…'", '"…"'], mb_substr($m, 0, 90)); $diag["outras"][$f] = ($diag["outras"][$f] ?? 0) + 1; }
}
foreach ($servidores as &$sv) { $e = $srvSeg[$sv["id"]] ?? ["falhas_1h" => 0, "falhas_24h" => 0, "ruido_24h" => 0]; $sv += $e; } unset($sv);
foreach ($srvSeg as $sid => $e) $vpn["por_srv"][] = ["id" => (string)$sid, "nome" => $nomeSrv[$sid] ?? "(servidor reiniciado ou desconhecido)"] + $e;
if ($dessH) { arsort($dessH); $hb = array_key_first($dessH); $vpn["dessinc_pico"] = $dessH[$hb]; $vpn["dessinc_pico_ts"] = $hb * HORA; }
$ipRu = []; arsort($vpn["ip_ruido"]);
foreach (array_slice($vpn["ip_ruido"], 0, 10, true) as $k => $n) { [$ip, $sid] = explode("|", $k); $ipRu[] = ["ip" => $ip, "n" => $n, "srv" => $nomeSrv[$sid] ?? "?"]; }
$vpn["ip_ruido"] = $ipRu;
$ipTop = []; arsort($vpn["ip"]);
foreach (array_slice($vpn["ip"], 0, 10, true) as $k => $n) { [$ip, $sid] = explode("|", $k); $ipTop[] = ["ip" => $ip, "n" => $n, "srv" => $nomeSrv[$sid] ?? "?"]; }
$vpn["ip"] = $ipTop; $vpn["u"] = topo($vpn["u"], 10, "u");

/* --- último IP público de cada usuário: fica no estado.json, então sobrevive à rotação do log --- */
foreach ($online as $u => $o) foreach (array_unique($o["ip"]) as $ip) if ($ip !== "") $conIp[$u][$ip] = $agora;
foreach ($conIp as $u => $ips) {
	if (!isset($est["usuarios"][$u])) continue;     // só quem já está no histórico: não cria usuário a partir de tentativa ou de UNDEF
	$h = $est["usuarios"][$u]["ips"] ?? [];
	foreach ($ips as $ip => $t) {
		$k = null; foreach ($h as $i => $x) if ($x["ip"] === (string)$ip) { $k = $i; break; }
		if ($k === null) $h[] = ["ip" => (string)$ip, "ts" => $t]; else $h[$k]["ts"] = max($h[$k]["ts"], $t);
	}
	usort($h, fn($a, $b) => $b["ts"] <=> $a["ts"]);
	$est["usuarios"][$u]["ips"] = array_slice($h, 0, 5);      // os 5 IPs mais recentes
}
foreach ($usuarios as &$us) { $h = $est["usuarios"][$us["u"]]["ips"] ?? []; $us["ip_ultimo"] = $h[0]["ip"] ?? null; $us["ips_recentes"] = $h; } unset($us);

$gui = ["falhas_1h" => 0, "falhas_24h" => 0, "ok_24h" => 0, "ip" => [], "u" => []];
$ssh = ["falhas_1h" => 0, "falhas_24h" => 0, "ok_24h" => 0, "bloqueios_24h" => 0, "ip" => [], "u" => []];
$conta = function (&$a, $ip, $u, $h) { $a["falhas_24h"]++; if ($h) $a["falhas_1h"]++; if ($ip !== "") $a["ip"][$ip] = ($a["ip"][$ip] ?? 0) + 1; if ($u !== "") $a["u"][nome_curto($u)] = ($a["u"][nome_curto($u)] ?? 0) + 1; };
foreach (linhas_log("/var/log/auth.log", $desde, $cobre, $lidos) as $r) {
	$m = $r["m"]; $h = $r["t"] >= $agora - HORA;
	if (preg_match("/webConfigurator authentication error for user '(.*)' from: ?(\S+)/", $m, $x)) { $conta($gui, $x[2], $x[1], $h); $marca("webGUI: falha", $m); continue; }
	if (preg_match("/Successful login for user '.*' from: ?\S+/", $m)) { $gui["ok_24h"]++; $marca("webGUI: login ok", $m); continue; }
	if ($r["p"] === "sshd") {
		if (preg_match('/(?:Failed \S+|authentication error) for (?:invalid user |illegal user )?(.*?) from ([0-9a-fA-F.:]+)/i', $m, $x)) { $conta($ssh, $x[2], $x[1], $h); $marca("ssh: falha", $m); continue; }
		if (preg_match('/^Accepted \S+ for .* from /', $m)) { $ssh["ok_24h"]++; $marca("ssh: login ok", $m); continue; }
	}
	if ($r["p"] === "sshguard" && preg_match('/^Blocking /', $m)) { $ssh["bloqueios_24h"]++; $marca("sshguard: bloqueio", $m); continue; }
}
foreach ([&$gui, &$ssh] as &$a) { $a["ip"] = topo($a["ip"]); $a["u"] = topo($a["u"], 10, "u"); } unset($a);

/* --- histórico de mudanças de configuração (Diagnostics > Backup & Restore > Config History) --- */
$revs = [];
$cur = cfg("revision");
if (!empty($cur["time"])) $revs[(int)$cur["time"]] = (string)($cur["description"] ?? "");
$bk = function_exists("get_backups") ? get_backups() : false;
if (is_array($bk)) { foreach ($bk as $k => $b) if ($k !== "versions" && is_array($b) && !empty($b["time"])) $revs[(int)$b["time"]] = (string)($b["description"] ?? ""); }
else { $c = @unserialize((string)@file_get_contents("/conf/backup/backup.cache")); if (is_array($c)) foreach ($c as $t => $b) $revs[(int)$t] = (string)($b["description"] ?? ""); }
krsort($revs);
$mud = [];
foreach (array_slice($revs, 0, 12, true) as $t => $d) {
	// "admin@1.2.3.4 (Local Database): User Manager: ..."  |  "(system): ..."
	$por = ""; $ip = ""; $txt = $d;
	if (preg_match('/^(.*?)(?:@([0-9a-fA-F.:]+))?(?: \([^)]*\))?: (.*)$/s', $d, $x)) { $por = $x[1]; $ip = $x[2] ?? ""; $txt = $x[3]; }
	$mud[] = ["ts" => $t, "por" => nome_curto($por), "ip" => $ip, "desc" => mb_substr($txt, 0, 160)];
}
$config_seg = ["ultima_ts" => $mud[0]["ts"] ?? 0, "ultima" => $mud ? (($mud[0]["por"] ?: "?") . ($mud[0]["ip"] ? "@" . $mud[0]["ip"] : "") . ": " . $mud[0]["desc"]) : "",
               "mudancas_24h" => count(array_filter(array_keys($revs), fn($t) => $t >= $desde)), "lista" => $mud];
$seguranca = ["cobre_desde" => $cobre, "logs" => count($lidos), "vpn" => $vpn, "gui" => $gui, "ssh" => $ssh, "config" => $config_seg];

$out = ["ts" => $agora, "historico_desde" => $est["desde"], "servidores" => $servidores, "usuarios" => $usuarios, "certificados" => $lista_c, "seguranca" => $seguranca,
        "resumo" => ["servidores" => count($servidores), "servidores_no_ar" => count(array_filter($servidores, fn($s) => $s["no_ar"])),
                     "conectados" => count($online), "usuarios" => count($usuarios), "certificados" => count($lista_c),
                     "tuneis" => count(array_filter($servidores, fn($s) => $s["tipo"] === "site")),
                     "tuneis_conectados" => count(array_filter($servidores, fn($s) => $s["tipo"] === "site" && $s["pares"]))]];

if ($DIAG) {
	echo "logs lidos: ", implode(", ", $lidos) ?: "nenhum (rode como root)", "\n";
	echo "cobertura: desde ", date("d/m H:i", $cobre), " (", round(($agora - $cobre) / 3600, 1), " h)\n";
	echo "processos OpenVPN mapeados: ", json_encode(array_map(fn($i) => $nomeSrv[$i] ?? $i, $pidSrv), JSON_UNESCAPED_UNICODE), "\n\n";
	echo "RECONHECIDAS nas últimas 24 h:\n"; ksort($diag["reconhecidas"]);
	foreach ($diag["reconhecidas"] as $k => $n) { printf("  %-40s %6d\n", $k, $n); foreach ($diag["amostras"][$k] as $a) echo "      ex.: $a\n"; }
	if (!$diag["reconhecidas"]) echo "  nada\n";
	echo "\nOUTRAS mensagens do openvpn (formato, sem dados), as 20 mais comuns:\n"; arsort($diag["outras"]);
	foreach (array_slice($diag["outras"], 0, 20, true) as $f => $n) printf("  %6d  %s\n", $n, $f);
	echo "\nresultado: VPN falhas 1h/24h=", $vpn["falhas_1h"], "/", $vpn["falhas_24h"], " usuários recusados 1h/24h=", $vpn["recusados_1h"], "/", $vpn["recusados_24h"],
	     " ruído 24h=", $vpn["ruido_24h"], " · webGUI falhas 24h=", $gui["falhas_24h"], " · SSH falhas 24h=", $ssh["falhas_24h"], " bloqueios=", $ssh["bloqueios_24h"],
	     " · mudanças de config 24h=", $config_seg["mudancas_24h"], "\n";
	exit(0);
}
if ($RESUMO) {
	echo "pfSense ", trim(@file_get_contents("/etc/version") ?: "?"), " · ", count($servidores), " servidor(es) OpenVPN na configuração, ", count($ativos), " ativo(s)\n";
	foreach ($servidores as $s) printf("  %-28s %-6s modo=%-16s auth=%s no_ar=%s conectados=%d\n", substr($s["nome"], 0, 28), $s["tipo"], $s["modo"], implode("+", $s["auth"]) ?: "-", $s["no_ar"] ? "sim" : "não", $s["conectados"]);
	$k = []; foreach ($ativos as $a) foreach (lista($a["conns"] ?? []) as $c) if (is_array($c)) { $k = array_keys($c); break 2; }
	echo "campos de uma conexão: ", $k ? implode(", ", $k) : "(ninguém conectado agora)", "\n";
	$t = array_count_values(array_column($lista_c, "tipo"));
	echo "certificados: ", json_encode($t), " · vencidos: ", count(array_filter($lista_c, fn($c) => $c["vence"] < $agora && !$c["revogado"])),
	     " · revogados: ", count(array_filter($lista_c, fn($c) => $c["revogado"])), "\n";
	echo "usuários: ", count($usuarios), " (locais: ", count(array_filter($usuarios, fn($u) => $u["origem"] === "local")), ") · conectados agora: ", count($online), "\n";
	echo "tamanho do JSON: ", strlen(json_encode($out)), " bytes\n";
	exit(0);
}
$tmp = DIR . "/ovpn.json.tmp";
file_put_contents($tmp, json_encode($out, JSON_UNESCAPED_UNICODE)); chmod($tmp, 0644); rename($tmp, DIR . "/ovpn.json");
file_put_contents(DIR . "/estado.json.tmp", json_encode($est, JSON_UNESCAPED_UNICODE)); rename(DIR . "/estado.json.tmp", DIR . "/estado.json");
