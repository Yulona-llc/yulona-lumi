import { BlockList, isIP } from "node:net";

/** CIDR allow-list; an empty list allows everything. IPv4-mapped IPv6 addresses are matched as IPv4. */
export function buildAllowList(cidrs: string[]): ((ip: string) => boolean) | null {
  if (cidrs.length === 0) return null;
  const list = new BlockList();
  for (const c of cidrs) {
    const [ip, bits] = c.split("/") as [string, string | undefined];
    const fam = isIP(ip) === 6 ? "ipv6" : "ipv4";
    if (bits === undefined) list.addAddress(ip, fam);
    else list.addSubnet(ip, Number(bits), fam);
  }
  return (raw: string) => {
    const ip = raw.replace(/^::ffff:/i, "");
    const f = isIP(ip);
    if (!f) return false;
    return list.check(ip, f === 6 ? "ipv6" : "ipv4");
  };
}
