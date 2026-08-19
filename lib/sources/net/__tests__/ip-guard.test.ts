// lib/sources/net/__tests__/ip-guard.test.ts
//
// Pure, no-I/O unit tests of the actual production classifier
// (isBlockedAddress) against every range CLAUDE.md's SSRF requirement
// enumerates by name, plus boundary conditions for each CIDR and the
// IPv6/IPv4-mapped/invalid-input edge cases called out in that module's
// header comment. This is the single most important test file in the
// project (CLAUDE.md: "Обязательно напиши unit-тесты именно на
// SSRF-защиту -- это самая security-критичная часть всего проекта").

import { describe, expect, it } from "vitest";
import { isBlockedAddress } from "../ip-guard";

describe("isBlockedAddress: ranges required by CLAUDE.md", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.255", "loopback, top of range"],
    ["10.0.0.1", "RFC1918 10.0.0.0/8"],
    ["10.255.255.255", "RFC1918 10.0.0.0/8, top of range"],
    ["172.16.0.1", "RFC1918 172.16.0.0/12, bottom of range"],
    ["172.31.255.255", "RFC1918 172.16.0.0/12, top of range"],
    ["192.168.0.1", "RFC1918 192.168.0.0/16"],
    ["192.168.255.255", "RFC1918 192.168.0.0/16, top of range"],
    ["169.254.0.1", "link-local 169.254.0.0/16"],
    ["169.254.169.254", "AWS/GCP/Azure cloud metadata address"],
    ["169.254.255.255", "link-local 169.254.0.0/16, top of range"],
  ])("blocks %s (%s)", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    ["172.15.255.255", "just below the 172.16.0.0/12 private range"],
    ["172.32.0.0", "just above the 172.16.0.0/12 private range"],
    ["8.8.8.8", "public (Google DNS)"],
    ["1.1.1.1", "public (Cloudflare DNS)"],
    ["93.184.216.34", "public (example.com, at time of writing)"],
  ])("does NOT block %s (%s)", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe("isBlockedAddress: additional hardening ranges (same risk category, not individually named in CLAUDE.md)", () => {
  it.each([
    ["0.0.0.0", "unspecified / this network"],
    ["100.64.0.1", "carrier-grade NAT (RFC6598)"],
  ])("blocks %s (%s)", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });
});

describe("isBlockedAddress: IPv6", () => {
  it.each([
    ["::1", "loopback"],
    ["fe80::1", "link-local"],
    ["fe80::abcd:1234:5678:9abc", "link-local, deep in fe80::/10"],
    ["fc00::1", "unique local (RFC4193)"],
    ["fd12:3456:789a::1", "unique local, within fc00::/7"],
    ["::", "unspecified address"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:169.254.169.254", "IPv4-mapped cloud metadata address"],
    ["::ffff:10.0.0.1", "IPv4-mapped RFC1918"],
  ])("blocks %s (%s)", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    ["2001:4860:4860::8888", "public (Google public DNS, IPv6)"],
    ["2606:4700:4700::1111", "public (Cloudflare DNS, IPv6)"],
    ["::ffff:8.8.8.8", "IPv4-mapped public address"],
  ])("does NOT block %s (%s)", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe("isBlockedAddress: fail-closed on invalid input", () => {
  it.each(["not-an-ip", "", "300.1.1.1", "1.2.3", "999.999.999.999"])(
    "treats %j as blocked (not a valid IP literal)",
    (address) => {
      expect(isBlockedAddress(address)).toBe(true);
    }
  );
});
