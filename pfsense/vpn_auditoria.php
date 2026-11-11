<?php
/*
 * Auditoria SOMENTE LEITURA da configuração de VPN/autenticação do pfSense.
 * Não altera nada. Não imprime senhas, chaves privadas, chaves TLS nem o corpo dos certificados.
 * Uso (Diagnostics > Command Prompt > Execute Shell Command):  php -q /tmp/vpn_auditoria.php
 */
require_once("config.inc");
require_once("certs.inc");

function g($p) { return function_exists('config_get_path') ? config_get_path($p, []) : []; }
function lista($v) { return is_array($v) ? (isset($v[0]) || empty($v) ? $v : [$v]) : []; }
function venc($crt) {
	$x = @openssl_x509_parse(base64_decode($crt ?? ''));
	return $x ? (int)floor(($x['validTo_time_t'] - time()) / 86400) : null;
}
function w($s = '') { echo $s, "\n"; }
$alertas = [];
function alerta($nivel, $txt) { global $alertas; $alertas[] = sprintf("[%s] %s", $nivel, $txt); }

$CA = []; foreach (lista(g('ca')) as $c) { $CA[$c['refid']] = $c; }
$CERT = []; foreach (lista(g('cert')) as $c) { $CERT[$c['refid']] = $c; }
$CRL = []; foreach (lista(g('crl')) as $c) { $CRL[$c['refid']] = $c; }
$AUTH = []; foreach (lista(g('system/authserver')) as $a) { $AUTH[$a['name']] = $a; }
$USERS = lista(g('system/user'));
$SRV = lista(g('openvpn/openvpn-server'));
$CLI = lista(g('openvpn/openvpn-client'));
$P1 = lista(g('ipsec/phase1'));
$uso = [];  // refid de CA/cert -> onde é usado
$usa = function ($ref, $onde) use (&$uso) { if ($ref) { $uso[$ref][] = $onde; } };

// CRL: refid de cert revogado
$revog = [];
foreach ($CRL as $r) { foreach (lista($r['cert'] ?? []) as $c) { $revog[$c['refid'] ?? ''] = true; } }

w("=== SERVIDORES DE AUTENTICAÇÃO (System > User Manager > Authentication Servers) ===");
if (!$AUTH) { w("  nenhum além do Local Database"); }
foreach ($AUTH as $n => $a) {
	$tipo = $a['type'] ?? '?';
	$tr = $a['ldap_urltype'] ?? ($a['radius_protocol'] ?? '');
	w(sprintf("  %-28s tipo=%-6s host=%s porta=%s transporte=%s", $n, $tipo, $a['host'] ?? '?', $a['ldap_port'] ?? ($a['radius_auth_port'] ?? '?'), $tr));
	if ($tipo == 'ldap') {
		w(sprintf("    base=%s  conta de bind=%s  consulta extra=%s  CA=%s",
			$a['ldap_basedn'] ?? '', ($a['ldap_binddn'] ?? '') ?: '(anônimo)',
			!empty($a['ldap_extended_enabled']) ? ($a['ldap_extended_query'] ?? '') : '(nenhuma: QUALQUER usuário ativo do AD entra)',
			isset($a['ldap_caref']) && isset($CA[$a['ldap_caref']]) ? $CA[$a['ldap_caref']]['descr'] : ($a['ldap_caref'] ?? '-')));
		$usa($a['ldap_caref'] ?? '', "auth:$n");
		if (stripos($tr, 'ssl') === false && stripos($tr, 'starttls') === false) {
			alerta('ALTO', "LDAP '$n' sem criptografia: senha dos usuários e da conta de bind trafegam em texto puro até o AD");
		}
		if (empty($a['ldap_extended_enabled'])) {
			alerta('ALTO', "LDAP '$n' sem filtro de grupo: qualquer conta ativa do AD (inclusive de serviço) autentica na VPN");
		}
		if (empty($a['ldap_binddn'])) { alerta('MEDIO', "LDAP '$n' com bind anônimo"); }
	}
}
w();

w("=== SERVIDORES OPENVPN ===");
$modos = ['p2p_tls' => 'túnel site (certificado)', 'p2p_shared_key' => 'túnel site (chave compartilhada)',
	'server_tls' => 'acesso SÓ CERTIFICADO', 'server_user' => 'acesso SÓ SENHA', 'server_tls_user' => 'acesso certificado + senha'];
foreach ($SRV as $s) {
	$n = $s['description'] ?? ('id ' . ($s['vpnid'] ?? '?'));
	$off = isset($s['disable']);
	$m = $s['mode'] ?? '?';
	$crl = $s['crlref'] ?? '';
	w(sprintf("  %-28s %-8s %s/%s if=%s modo=%s", $n, $off ? 'DESLIG.' : 'ligado', $s['local_port'] ?? '?', $s['protocol'] ?? '?', $s['interface'] ?? '?', $modos[$m] ?? $m));
	w(sprintf("    CA=%s  cert=%s  CRL=%s  chave TLS=%s  autenticação=%s  CN estrito=%s",
		isset($CA[$s['caref'] ?? '']) ? $CA[$s['caref']]['descr'] : '-',
		isset($CERT[$s['certref'] ?? '']) ? $CERT[$s['certref']]['descr'] : '-',
		$crl ? ($CRL[$crl]['descr'] ?? 'inexistente!') : 'nenhuma',
		!empty($s['tls']) ? ($s['tls_type'] ?? 'sim') : 'NÃO',
		$s['authmode'] ?? '-', !empty($s['strictusercn']) ? 'sim' : 'não'));
	$usa($s['caref'] ?? '', "ovpn:$n"); $usa($s['certref'] ?? '', "ovpn:$n");
	if ($off) { alerta('BAIXO', "OpenVPN '$n' desligado mas ainda na configuração: candidato a remoção"); continue; }
	if ($m == 'server_user') { alerta('ALTO', "OpenVPN '$n' só com senha: exposto a força bruta"); }
	if ($m == 'server_tls') { alerta('ALTO', "OpenVPN '$n' só com certificado: qualquer cert não revogado da CA '" . ($CA[$s['caref'] ?? '']['descr'] ?? '?') . "' entra, inclusive de ex-funcionários"); }
	if (in_array($m, ['server_tls', 'server_tls_user', 'p2p_tls']) && !$crl) { alerta('MEDIO', "OpenVPN '$n' sem CRL: revogar um certificado não tem efeito"); }
	if (empty($s['tls'])) { alerta('MEDIO', "OpenVPN '$n' sem chave TLS (tls-auth/tls-crypt): porta responde a qualquer um na internet"); }
	if ($m == 'server_tls_user' && empty($s['strictusercn'])) { alerta('BAIXO', "OpenVPN '$n' sem CN estrito: usuário pode usar o certificado de outro com a própria senha"); }
	foreach (array_map('trim', explode(',', $s['authmode'] ?? '')) as $am) {
		if ($am && $am != 'Local Database' && !isset($AUTH[$am])) { alerta('ALTO', "OpenVPN '$n' aponta para servidor de autenticação inexistente '$am'"); }
	}
}
foreach ($CLI as $c) { $usa($c['caref'] ?? '', "ovpn-cliente:" . ($c['description'] ?? '')); $usa($c['certref'] ?? '', "ovpn-cliente:" . ($c['description'] ?? '')); }
foreach ($P1 as $p) { $usa($p['caref'] ?? '', "ipsec:" . ($p['descr'] ?? '')); $usa($p['certref'] ?? '', "ipsec:" . ($p['descr'] ?? '')); }
$usa(config_get_path('system/webgui/ssl-certref', ''), 'webgui');
w();

$certUser = []; foreach ($USERS as $u) { foreach (lista($u['cert'] ?? []) as $r) { $certUser[$r] = $u['name']; } }

w("=== CAs ===");
foreach ($CA as $r => $c) {
	$filhos = array_filter($CERT, fn($x) => ($x['caref'] ?? '') == $r);
	$ativos = array_filter($filhos, fn($x) => !isset($revog[$x['refid']]) && (venc($x['crt'] ?? '') ?? 1) > 0);
	$onde = $uso[$r] ?? [];
	w(sprintf("  %-28s vence em %5s d  chave privada=%s  certs emitidos=%d (válidos e não revogados=%d)  usada em: %s",
		$c['descr'] ?? $r, venc($c['crt'] ?? '') ?? '?', !empty($c['prv']) ? 'sim' : 'não', count($filhos), count($ativos), $onde ? implode(', ', $onde) : 'NADA'));
	if (!$onde) { alerta('BAIXO', "CA '" . ($c['descr'] ?? $r) . "' não é usada por nada: candidata a remoção (remova antes os certs que ela emitiu)"); }
}
w();

w("=== CERTIFICADOS NÃO LIGADOS A NADA NO PFSENSE (nem servidor, nem usuário local, nem webGUI/IPsec) ===");
w("  Podem ser do outro lado de um túnel, certificados distribuídos a usuários do AD ou lixo antigo. Válido + não revogado + CA ainda em uso = ainda abre porta.");
$k = 0;
foreach ($CERT as $r => $c) {
	if (isset($uso[$r]) || isset($certUser[$r])) { continue; }
	$k++;
	w(sprintf("  %-34s CA=%-22s tipo=%-7s vence em %5s d%s", $c['descr'] ?? $r, $CA[$c['caref'] ?? '']['descr'] ?? '(externa)', $c['type'] ?? '?', venc($c['crt'] ?? '') ?? '?', isset($revog[$r]) ? '  (revogado)' : ''));
}
if (!$k) { w("  nenhum"); }
w();

w("=== USUÁRIOS LOCAIS ===");
$gen = '/^(admin|administrator|config|domain|test|teste|temp|tmp|user|usuario|vpn|suporte|support|guest|convidado|ti|infra|backup)\d*$/i';
foreach ($USERS as $u) {
	$n = $u['name'] ?? '?';
	$exp = $u['expires'] ?? '';
	$expd = $exp ? (int)floor((strtotime($exp) - time()) / 86400) : null;
	$certs = lista($u['cert'] ?? []);
	w(sprintf("  %-24s %-9s expira=%-12s certs=%d grupos/priv=%s%s", $n, isset($u['disabled']) ? 'DESLIG.' : 'ativo', $exp ?: '-', count($certs),
		implode('|', array_merge(lista($u['groupname'] ?? []), lista($u['priv'] ?? []))) ?: '-',
		preg_match($gen, $n) ? '   <- nome genérico' : ''));
	if (preg_match($gen, $n) && !isset($u['disabled']) && $n != 'admin') { alerta('MEDIO', "Usuário local genérico '$n' ativo: confirme quem usa"); }
	if ($expd !== null && $expd < 0 && !isset($u['disabled'])) { alerta('BAIXO', "Usuário '$n' expirado em $exp ainda na base"); }
}
w();

w("=== ALERTAS (" . count($alertas) . ") ===");
usort($alertas, fn($a, $b) => array_search(substr($a, 1, 4), ['ALTO', 'MEDI', 'BAIX']) <=> array_search(substr($b, 1, 4), ['ALTO', 'MEDI', 'BAIX']));
foreach ($alertas as $a) { w("  $a"); }
