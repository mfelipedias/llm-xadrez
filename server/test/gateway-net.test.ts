/**
 * Utilitários de rede do gateway: CIDR, regra de administração e inferência de `local`.
 */
import { describe, expect, it } from "vitest";
import { ipInList, ipMatches, isLocalUrl, isValidIpOrCidr, parseIPv6 } from "../src/bots/providers/net.js";
import { isAdminRequest } from "../src/http/api.js";
import { isEffectivelyLocal } from "../src/bots/providers/types.js";

describe("ipMatches — IPv4/IPv6 exato e CIDR", () => {
  it("IPv4 CIDR e exato, com e sem prefixo ::ffff:", () => {
    expect(ipMatches("172.18.0.1", "172.16.0.0/12")).toBe(true);
    expect(ipMatches("::ffff:172.18.0.1", "172.16.0.0/12")).toBe(true);
    expect(ipMatches("172.32.0.1", "172.16.0.0/12")).toBe(false);
    expect(ipMatches("192.168.1.20", "192.168.1.20")).toBe(true);
    expect(ipMatches("192.168.1.21", "192.168.1.20")).toBe(false);
    expect(ipMatches("10.1.2.3", "0.0.0.0/0")).toBe(true);
    expect(ipMatches("100.100.1.1", "100.64.0.0/10")).toBe(true);
  });

  it("IPv6 exato (formas diferentes) e CIDR", () => {
    expect(ipMatches("fe80::1", "fe80:0:0:0:0:0:0:1")).toBe(true);
    expect(ipMatches("fd12:3456::1", "fc00::/7")).toBe(true);
    expect(ipMatches("2001:db8::1", "fc00::/7")).toBe(false);
    expect(parseIPv6("::ffff:1.2.3.4")).toBe(0xffff01020304n);
  });

  it("entradas inválidas nunca casam", () => {
    expect(ipMatches("10.0.0.1", "10.0.0.0/33")).toBe(false);
    expect(ipMatches("10.0.0.1", "banana")).toBe(false);
    expect(ipMatches("10.0.0.1", "10.0.0.0/8/1")).toBe(false);
    expect(ipMatches("10.0.0.1", "::/0")).toBe(false); // família diferente
    expect(isValidIpOrCidr("172.16.0.0/12")).toBe(true);
    expect(isValidIpOrCidr("fe80::/10")).toBe(true);
    expect(isValidIpOrCidr("300.1.1.1")).toBe(false);
    expect(ipInList(undefined, ["0.0.0.0/0"])).toBe(false);
  });
});

describe("isAdminRequest", () => {
  const opts = { adminToken: "segredo", adminAllowFrom: ["172.16.0.0/12"] };

  it("loopback sempre administra (mesmo com token definido)", () => {
    expect(isAdminRequest("127.0.0.1", undefined, opts)).toBe(true);
    expect(isAdminRequest("::1", undefined, opts)).toBe(true);
    expect(isAdminRequest("::ffff:127.0.0.1", undefined, opts)).toBe(true);
  });

  it("IP da bridge do Docker (ADMIN_ALLOW_FROM) administra sem token", () => {
    expect(isAdminRequest("::ffff:172.17.0.1", undefined, opts)).toBe(true);
    expect(isAdminRequest("192.168.0.10", undefined, opts)).toBe(false);
  });

  it("fora da lista, só com o Bearer certo", () => {
    expect(isAdminRequest("203.0.113.1", "Bearer segredo", opts)).toBe(true);
    expect(isAdminRequest("203.0.113.1", "bearer   segredo", opts)).toBe(true);
    expect(isAdminRequest("203.0.113.1", "Bearer errado", opts)).toBe(false);
    expect(isAdminRequest("203.0.113.1", "segredo", opts)).toBe(false);
    expect(isAdminRequest("203.0.113.1", "Bearer segredo", { adminAllowFrom: [] })).toBe(false);
    expect(isAdminRequest(undefined, undefined, {})).toBe(false);
  });
});

describe("isLocalUrl / isEffectivelyLocal", () => {
  it("loopback e faixas da rede local são locais", () => {
    for (const url of [
      "http://localhost:11434/v1",
      "http://127.0.0.1:1234/v1",
      "http://[::1]:8080/v1",
      "http://10.0.0.5:8000/v1",
      "http://172.20.1.1/v1",
      "http://192.168.1.50:11434/v1",
      "http://100.101.102.103:11434/v1",
      "http://[fe80::1]:1234/v1",
      "http://[fd00::5]/v1",
      "http://gpu-box.local:11434/v1",
      "http://servidor.lan/v1",
      "http://host.docker.internal:11434/v1",
      "http://ollama:11434/v1",
    ]) {
      expect(isLocalUrl(url), url).toBe(true);
    }
  });

  it("hosts públicos não são locais", () => {
    for (const url of ["https://openrouter.ai/api/v1", "http://8.8.8.8/v1", "http://172.32.0.1/v1", "https://[2001:db8::1]/v1", "ftp://localhost/"]) {
      expect(isLocalUrl(url), url).toBe(false);
    }
    expect(isLocalUrl(undefined)).toBe(false);
  });

  it("`local` explícito vence a inferência", () => {
    expect(isEffectivelyLocal({ baseUrl: "http://192.168.0.2/v1" })).toBe(true);
    expect(isEffectivelyLocal({ baseUrl: "http://192.168.0.2/v1", local: false })).toBe(false);
    expect(isEffectivelyLocal({ baseUrl: "https://api.exemplo.com/v1", local: true })).toBe(true);
  });
});
