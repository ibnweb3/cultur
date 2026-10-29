import data from "../../registry/cases.json";

export interface Case {
  id: string;
  names: string[];
  aliases: { name: string; kind: string; source: string }[];
  wallets: { address: string }[];
  facts: string[];
  adverse_status: string;
  continuity_status: string;
  continuity_note: string;
  sources: string[];
  qloo_anchor_names: string[];
  chain: string;
}
export const cases = (data as unknown as { cases: Case[] }).cases;

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
export const namesOf = (c: Case) => [...c.names, ...c.aliases.map((a) => a.name)];
export const findByName = (t: string) => {
  const n = norm(t);
  return n ? cases.filter((c) => namesOf(c).some((x) => norm(x) === n)) : [];
};
export const findByWallet = (a: string) => cases.filter((c) => c.wallets.some((w) => w.address.toLowerCase() === a.toLowerCase()));
