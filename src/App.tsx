import { useEffect, useMemo, useState } from "react";
import { AmmoraDataApiClient } from "@ammora-protocol/sdk";

const CHAIN_ID = 91_342n; // GIWA Sepolia testnet
const client = new AmmoraDataApiClient("https://ammora-giwa-sepolia-data.fly.dev");

// Shape of a launch is not fully documented, so we read fields defensively.
type Launch = Record<string, unknown>;

const pick = (l: Launch, keys: string[]): string => {
  for (const k of keys) {
    const v = l[k];
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  return "—";
};

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export default function App() {
  const [launches, setLaunches] = useState<Launch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res: unknown = await client.getLaunches({ chainId: CHAIN_ID });
        const list = Array.isArray(res)
          ? res
          : ((res as { items?: unknown[]; launches?: unknown[] }).items ??
             (res as { launches?: unknown[] }).launches ?? []);
        setLaunches(list as Launch[]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return launches;
    return launches.filter((l) => JSON.stringify(l).toLowerCase().includes(q));
  }, [launches, query]);

  return (
    <main className="wrap">
      <header>
        <span className="badge">GIWA Sepolia · testnet</span>
        <h1>Ammora Launch Explorer</h1>
        <p className="sub">Live token launches built on the Ammora SDK.</p>
        <input
          className="search"
          placeholder="Search by name, symbol or address…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </header>

      {loading && <p className="state">Loading launches…</p>}
      {error && <p className="state err">Error: {error}</p>}
      {!loading && !error && filtered.length === 0 && <p className="state">No launches found.</p>}

      <section className="grid">
        {filtered.map((l, i) => {
          const addr = pick(l, ["tokenAddress", "token", "address", "baseToken"]);
          return (
            <article className="card" key={addr + i}>
              <h3>{pick(l, ["name", "tokenName"])}</h3>
              <p className="sym">{pick(l, ["symbol", "tokenSymbol"])}</p>
              <p className="addr">{short(addr)}</p>
              <details>
                <summary>Raw data</summary>
                <pre>{JSON.stringify(l, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)}</pre>
              </details>
            </article>
          );
        })}
      </section>
    </main>
  );
}
