import { useEffect, useMemo, useState } from "react";
import { createPublicClient, createWalletClient, custom, defineChain, formatEther, http } from "viem";
import { AmmoraDataApiClient } from "@ammora-protocol/sdk";

const giwa = defineChain({
  id: 91342,
  name: "GIWA Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia-rpc.giwa.io"] } },
  blockExplorers: { default: { name: "GIWA Explorer", url: "https://sepolia-explorer.giwa.io" } },
});

const publicClient = createPublicClient({ chain: giwa, transport: http() });
const dataApi = new AmmoraDataApiClient(window.location.origin + "/ammora-api");

type Launch = Record<string, unknown>;

const pick = (l: Launch, keys: string[]): string => {
  for (const k of keys) {
    const v = l[k];
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  return "—";
};
const short = (a: string) => (a.length > 12 ? a.slice(0, 6) + "…" + a.slice(-4) : a);

export default function App() {
  const [block, setBlock] = useState<string>("…");
  const [account, setAccount] = useState<string | null>(null);
  const [balance, setBalance] = useState<string>("");
  const [walletError, setWalletError] = useState<string | null>(null);

  const [launches, setLaunches] = useState<Launch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    publicClient.getBlockNumber().then((b) => setBlock(b.toString())).catch(() => setBlock("n/a"));
  }, []);

  async function connect() {
    setWalletError(null);
    const eth = (window as any).ethereum;
    if (!eth) {
      setWalletError("Кошелёк не найден. Установи MetaMask.");
      return;
    }
    try {
      const wallet = createWalletClient({ chain: giwa, transport: custom(eth) });
      const [addr] = await wallet.requestAddresses();
      try {
        await wallet.switchChain({ id: giwa.id });
      } catch {
        await wallet.addChain({ chain: giwa });
        await wallet.switchChain({ id: giwa.id });
      }
      setAccount(addr);
      const bal = await publicClient.getBalance({ address: addr });
      setBalance(Number(formatEther(bal)).toFixed(4));
    } catch (e) {
      setWalletError(e instanceof Error ? e.message : String(e));
    }
  }

  async function loadLaunches() {
    setLoading(true);
    setError(null);
    try {
      const timeout = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("timeout")), 12000)
      );
      const res: any = await Promise.race([dataApi.getLaunches({ chainId: 91_342n }), timeout]);
      const list = Array.isArray(res) ? res : res?.items ?? res?.launches ?? [];
      setLaunches(list as Launch[]);
    } catch {
      setError("Сервер данных Ammora сейчас недоступен. Попробуй позже.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadLaunches();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return launches;
    return launches.filter((l) => JSON.stringify(l, (_, v) => (typeof v === "bigint" ? v.toString() : v)).toLowerCase().includes(q));
  }, [launches, query]);

  return (
    <main className="wrap">
      <header>
        <span className="badge">GIWA Sepolia · testnet</span>
        <h1>Ammora Launch Explorer</h1>
        <p className="sub">Live token launches built on the Ammora SDK.</p>

        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
          <button
            onClick={connect}
            style={{ background: "#111", color: "#fff", border: 0, borderRadius: 999, padding: "10px 20px", fontWeight: 600, cursor: "pointer" }}
          >
            {account ? short(account) : "Connect wallet"}
          </button>
          {account && <span className="sub" style={{ margin: 0 }}>Balance: {balance} ETH</span>}
          <span className="sub" style={{ margin: 0 }}>Block: #{block}</span>
        </div>
        {walletError && <p className="state err">{walletError}</p>}

        <input
          className="search"
          placeholder="Search by name, symbol or address…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </header>

      {loading && <p className="state">Loading launches…</p>}
      {error && (
        <p className="state err">
          {error}{" "}
          <button onClick={loadLaunches} style={{ cursor: "pointer" }}>Повторить</button>
        </p>
      )}
      {!loading && !error && filtered.length === 0 && <p className="state">No launches found.</p>}

      <section className="grid">
        {filtered.map((l, i) => {
          const addr = pick(l, ["tokenAddress", "token", "address", "baseToken"]);
          return (
            <article className="card" key={addr + i}>
              <h3>{pick(l, ["name", "tokenName"])}</h3>
              <p className="sym">{pick(l, ["symbol", "tokenSymbol"])}</p>
              <p className="addr">{short(addr)}</p>
            </article>
          );
        })}
      </section>
    </main>
  );
}
