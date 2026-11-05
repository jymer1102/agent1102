// Server-side fetches of user-supplied URLs (link previews, /study links) must never reach private or internal
// addresses. Two things matter and both are handled here:
//   1. Is this address public?  isPrivateIp() normalises IPv6 first, so every spelling of an IPv4-mapped address
//      (::ffff:127.0.0.1 and its hex form ::ffff:7f00:1) is judged by its IPv4 rules.
//   2. Is the address we CONNECT to the one we checked?  Checking with one DNS lookup and fetching with another lets
//      a hostile DNS server answer "public" first and "127.0.0.1" second (DNS rebinding). safeFetch() therefore
//      validates inside the socket's own lookup, so the checked address is the connected address.
const dns = require("dns");
const net = require("net");
const { Agent, fetch: undiciFetch } = require("undici");

const blocked = new net.BlockList();
[
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
].forEach(([a, p]) => blocked.addSubnet(a, p, "ipv4"));
[
  ["::", 96],            // unspecified, loopback and the deprecated IPv4-compatible range
  ["64:ff9b::", 96],     // NAT64: can embed any IPv4 address
  ["64:ff9b:1::", 48],
  ["100::", 64],         // discard-only
  ["2001::", 32],        // Teredo: embeds IPv4
  ["2001:db8::", 32],    // documentation
  ["2002::", 16],        // 6to4: embeds IPv4
  ["fc00::", 7],         // unique local
  ["fe80::", 10],        // link-local
  ["fec0::", 10],        // old site-local
  ["ff00::", 8],         // multicast
].forEach(([a, p]) => blocked.addSubnet(a, p, "ipv6"));

function isPrivateIp(ip) {
  ip = String(ip || "").trim();
  if (net.isIPv4(ip)) return blocked.check(ip, "ipv4");
  if (!net.isIPv6(ip)) return true; // not an address we can reason about: refuse
  let v;
  try { v = new URL("http://[" + ip + "]/").hostname.slice(1, -1).toLowerCase(); } catch (_) { return true; } // also rejects zone ids like fe80::1%eth0
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v) || /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) {
    if (mapped.length === 2) return isPrivateIp(mapped[1]);
    const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
    return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return blocked.check(v, "ipv6");
}

// An address typed straight into the URL (http://10.0.0.5/, http://[::1]/) never goes through DNS, so check it up front.
function assertPublicUrl(u) {
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol");
  if (u.username || u.password) throw new Error("credentials in url");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isPrivateIp(host)) throw new Error("private address");
}

// Used by the socket for hostnames: look the name up, refuse if ANY answer is private, and connect to what we checked.
const makeGuardedLookup = (isPrivate = isPrivateIp) => function guardedLookup(hostname, options, cb) {
  if (typeof options === "function") { cb = options; options = {}; }
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some(a => isPrivate(a.address))) return cb(new Error("private address"));
    if (options && options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
};

const agent = new Agent({ connect: { lookup: makeGuardedLookup() } });

// Like fetch(), for a URL we don't trust. Redirects are NOT followed here (callers re-check every hop themselves).
async function safeFetch(url, init = {}) { // always async: a refusal is a rejected promise, never a synchronous throw
  const u = url instanceof URL ? url : new URL(String(url));
  assertPublicUrl(u);
  return undiciFetch(u, { ...init, redirect: "manual", dispatcher: agent });
}

module.exports = { isPrivateIp, assertPublicUrl, safeFetch, makeGuardedLookup };
