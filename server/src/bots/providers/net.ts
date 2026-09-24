/**
 * Utilitários de rede puros (sem I/O): parsing de IPv4/IPv6, casamento com CIDR e a
 * classificação "local" de uma baseUrl. Usados pelo registry (inferência de `local`),
 * pelo diagnóstico de erros de conexão e pela regra de administração da API REST.
 */

/** "192.168.0.1" → inteiro de 32 bits; null se não for IPv4 com 4 octetos. */
export function parseIPv4(text: string): number | null {
  const parts = text.trim().split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out;
}

/** IPv6 (inclusive "::", "::ffff:1.2.3.4" e zona "%eth0") → bigint de 128 bits; null se inválido. */
export function parseIPv6(text: string): bigint | null {
  let s = text.trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(":")) return null;

  // IPv4 embutido no fim ("::ffff:10.0.0.1") vira dois hextetos.
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let out = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out = (out << 16n) | BigInt(parseInt(g, 16));
  }
  return out;
}

/** Tira o prefixo IPv4-mapeado ("::ffff:172.18.0.1" → "172.18.0.1") e colchetes. */
export function normalizeIp(ip: string): string {
  let s = ip.trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  return mapped ? mapped[1] : s;
}

/**
 * `ip` casa com `entry` (IP exato ou CIDR, IPv4 ou IPv6)? Entradas inválidas nunca casam.
 * IPv4 mapeado em IPv6 é comparado como IPv4.
 */
export function ipMatches(ip: string, entry: string): boolean {
  const addr = normalizeIp(ip);
  const [rawNet, rawBits, ...extra] = entry.trim().split("/");
  if (extra.length || !rawNet) return false;
  const net = normalizeIp(rawNet);
  if (rawBits !== undefined && !/^\d{1,3}$/.test(rawBits)) return false;

  const a4 = parseIPv4(addr);
  const n4 = parseIPv4(net);
  if (a4 !== null || n4 !== null) {
    if (a4 === null || n4 === null) return false;
    const bits = rawBits === undefined ? 32 : Number(rawBits);
    if (bits > 32) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : ~(0xffffffff >>> bits) >>> 0;
    return ((a4 & mask) >>> 0) === ((n4 & mask) >>> 0);
  }

  const a6 = parseIPv6(addr);
  const n6 = parseIPv6(net);
  if (a6 === null || n6 === null) return false;
  const bits = rawBits === undefined ? 128 : Number(rawBits);
  if (bits > 128) return false;
  if (bits === 0) return true;
  const shift = BigInt(128 - bits);
  return a6 >> shift === n6 >> shift;
}

/** `ip` casa com alguma entrada da lista (IPs/CIDRs)? */
export function ipInList(ip: string | undefined, list: readonly string[]): boolean {
  if (!ip) return false;
  return list.some((entry) => ipMatches(ip, entry));
}

/** Entrada de ADMIN_ALLOW_FROM que não é um IP nem um CIDR válido (para avisar no log). */
export function isValidIpOrCidr(entry: string): boolean {
  const [net, bits, ...extra] = entry.trim().split("/");
  if (extra.length || !net) return false;
  const n = normalizeIp(net);
  if (parseIPv4(n) !== null) return bits === undefined || (/^\d{1,2}$/.test(bits) && Number(bits) <= 32);
  if (parseIPv6(n) !== null) return bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= 128);
  return false;
}

export function isLoopbackIp(ip: string | undefined): boolean {
  if (!ip) return false;
  const v = normalizeIp(ip);
  return v === "::1" || ipMatches(v, "127.0.0.0/8");
}

const LOOPBACK_V4 = ["127.0.0.0/8", "0.0.0.0/32"];
const PRIVATE_V4 = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16"];
const PRIVATE_V6 = ["fe80::/10", "fc00::/7"];

/** Hostname sem colchetes e em minúsculas, ou null se a URL não for http(s) válida. */
export function urlHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

/** localhost, 127.x, ::1, 0.0.0.0 — "o próprio computador" (no Docker: o próprio container). */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (parseIPv4(h) !== null) return LOOPBACK_V4.some((c) => ipMatches(h, c));
  const v6 = parseIPv6(h);
  return v6 !== null && (v6 === 1n || v6 === 0n || isLoopbackIp(normalizeIp(h)));
}

/**
 * Host da rede local: faixas privadas (10/8, 172.16/12, 192.168/16), CGNAT/Tailscale
 * (100.64/10), link-local, IPv6 ULA/link-local, `*.local`, `*.lan`, `*.internal`
 * (inclui host.docker.internal), `*.home.arpa` e nomes sem ponto (serviço do compose,
 * nome NetBIOS/mDNS de uma máquina da casa).
 */
export function isPrivateHost(host: string): boolean {
  const h = normalizeIp(host);
  if (parseIPv4(h) !== null) return PRIVATE_V4.some((c) => ipMatches(h, c));
  if (parseIPv6(h) !== null) return PRIVATE_V6.some((c) => ipMatches(h, c));
  if (/\.(local|lan|internal|home\.arpa)$/.test(h)) return true;
  return /^[a-z0-9-]+$/.test(h);
}

/** baseUrl aponta para o próprio computador ou para a rede local? */
export function isLocalUrl(url: string | undefined): boolean {
  const host = urlHost(url);
  if (!host) return false;
  return isLoopbackHost(host) || isPrivateHost(host);
}
