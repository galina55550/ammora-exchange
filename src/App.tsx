import { useEffect, useState } from "react";
import { createPublicClient, createWalletClient, custom, defineChain, formatEther, http } from "viem";
import {
  buildCreateAmmoraV4Launch,
  getAmmoraV4ConfigAtBlock,
  getAmmoraV4NextConfigId,
  giwaSepoliaAutoRoute,
  giwaSepoliaAutoRouteDeployment,
  parseAmmoraV4LaunchCreatedReceipt,
  resolveAmmoraFinalizedHead,
  verifyAmmoraV4CoreAtBlock,
} from "@ammora-protocol/sdk";

const deployment = giwaSepoliaAutoRouteDeployment;
const contracts = deployment.contracts.launch;
const rpcUrl = deployment.chain.rpcUrls[0];
const EXPLORER = "https://sepolia-explorer.giwa.io";

const chain = defineChain({
  id: deployment.chain.id,
  name: deployment.chain.name,
  nativeCurrency: deployment.chain.nativeCurrency,
  rpcUrls: { default: { http: [rpcUrl] } },
});
const client = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 0 }) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);

type ConfigRow = { id: bigint; enabled: boolean; decimals: number; fee: bigint; hash: string };

export default function App() {
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [balance, setBalance] = useState("");
  const [verified, setVerified] = useState(false);
  const [configs, setConfigs] = useState<ConfigRow[]>([]);
  const [loadMsg, setLoadMsg] = useState("Checking the Ammora deployment…");
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [configId, setConfigId] = useState("");
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [uri, setUri] = useState("ipfs://example/metadata.json");

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ token: string; curve: string; hash: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const block = await resolveAmmoraFinalizedHead([client], giwaSepoliaAutoRoute.finality);
        await verifyAmmoraV4CoreAtBlock(client, {
          configRegistry: contracts.configRegistry,
          launchFactory: contracts.factory,
          graduationAdapter: contracts.graduationAdapter,
          feePolicy: contracts.feePolicy,
        }, block);
        setVerified(true);
        setLoadMsg("Loading launch configs…");
        const next = await getAmmoraV4NextConfigId(client, contracts.configRegistry, block);
        const last = next > 1n ? next - 1n : 0n;
        const stop = last > 5n ? last - 4n : 1n;
        for (let id = last; id >= stop && id >= 1n; id -= 1n) {
          const c: any = await getAmmoraV4ConfigAtBlock(client, contracts.configRegistry, id, block);
          const row: ConfigRow = {
            id, enabled: c.enabled, decimals: c.config.tokenDecimals,
            fee: c.config.poolCreationFee, hash: c.configHash,
          };
          setConfigs((prev) => [...prev, row]);
          setConfigId((cur) => (cur === "" && row.enabled ? id.toString() : cur));
          await sleep(1000);
        }
        setLoadMsg("");
      } catch (e) {
        setLoadErr(e instanceof Error ? e.message : String(e));
        setLoadMsg("");
      }
    })();
  }, []);

  async function connect() {
    setError(null);
    const eth = (window as any).ethereum;
    if (!eth) return setError("Wallet not found. Install MetaMask.");
    try {
      const wallet = createWalletClient({ chain, transport: custom(eth) });
      const [addr] = await wallet.requestAddresses();
      try {
        await wallet.switchChain({ id: chain.id });
      } catch {
        await wallet.addChain({ chain });
        await wallet.switchChain({ id: chain.id });
      }
      setAccount(addr);
      setBalance(Number(formatEther(await client.getBalance({ address: addr }))).toFixed(4));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function launch() {
    setError(null);
    setResult(null);
    const selected = configs.find((c) => c.id.toString() === configId);
    if (!account) return setError("Connect your wallet first.");
    if (!verified) return setError("Deployment check failed; launching is disabled.");
    if (!selected || !selected.enabled) return setError("Choose an enabled config.");
    if (!name.trim() || !symbol.trim() || !uri.trim()) return setError("Fill in name, symbol and metadata URI.");

    setBusy(true);
    try {
      const eth = (window as any).ethereum;
      const wallet = createWalletClient({ account, chain, transport: custom(eth) });
      const tx = buildCreateAmmoraV4Launch({
        name: name.trim(),
        symbol: symbol.trim(),
        metadataURI: uri.trim(),
        creatorMetadataURI: uri.trim(),
        tokenDecimals: selected.decimals,
      }, selected.id, selected.fee);

      setStatus("Checking balance and simulating…");
      const bal = await client.getBalance({ address: account });
      if (bal < tx.value) throw new Error("Not enough test ETH to cover the creation fee.");
      await client.call({ account, to: contracts.factory, data: tx.data, value: tx.value });

      setStatus("Confirm the transaction in your wallet…");
      const hash = await wallet.sendTransaction({
        account, chain, to: contracts.factory, data: tx.data, value: tx.value,
      });

      setStatus("Waiting for confirmation…");
      const receipt = await client.waitForTransactionReceipt({
        hash, retryCount: 0, timeout: 120_000, pollingInterval: 3000,
      });
      if (receipt.status !== "success") throw new Error("Transaction reverted: " + hash);
      const created: any = parseAmmoraV4LaunchCreatedReceipt(receipt, contracts.factory);
      setResult({ token: created.token, curve: created.curve, hash });
      setStatus(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  const gap = { marginTop: 12, display: "block" } as const;

  return (
    <main className="wrap">
      <header>
        <span className="badge">GIWA Sepolia · testnet</span>
        <h1>Ammora Launchpad</h1>
        <p className="sub">Launch a token on an Ammora bonding curve in one transaction.</p>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={connect}
            style={{ background: "#111", color: "#fff", border: 0, borderRadius: 999, padding: "10px 20px", fontWeight: 600, cursor: "pointer" }}>
            {account ? short(account) : "Connect wallet"}
          </button>
          {account && <span className="sub" style={{ margin: 0 }}>Balance: {balance} ETH</span>}
          <span className="sub" style={{ margin: 0 }}>{verified ? "✓ Deployment verified" : ""}</span>
        </div>
      </header>

      {loadMsg && <p className="state">{loadMsg}</p>}
      {loadErr && <p className="state err">Could not load Ammora contracts: {loadErr}</p>}

      <section className="card" style={{ marginTop: 24, maxWidth: 560 }}>
        <h3>Create token</h3>
        <label style={gap}>Launch config
          <select className="search" style={{ marginTop: 4 }} value={configId} onChange={(e) => setConfigId(e.target.value)}>
            <option value="">Select…</option>
            {configs.map((c) => (
              <option key={c.id.toString()} value={c.id.toString()} disabled={!c.enabled}>
                Config #{c.id.toString()} {c.enabled ? "" : "(disabled)"}
              </option>
            ))}
          </select>
        </label>
        <label style={gap}>Token name
          <input className="search" style={{ marginTop: 4 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="My Token" />
        </label>
        <label style={gap}>Symbol
          <input className="search" style={{ marginTop: 4 }} value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="MTK" />
        </label>
        <label style={gap}>Metadata URI
          <input className="search" style={{ marginTop: 4 }} value={uri} onChange={(e) => setUri(e.target.value)} />
        </label>
        <button onClick={launch} disabled={busy}
          style={{ ...gap, background: "#6d4aff", color: "#fff", border: 0, borderRadius: 999, padding: "12px 24px", fontWeight: 600, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>
          {busy ? "Working…" : "Launch token"}
        </button>
        {status && <p className="state">{status}</p>}
        {error && <p className="state err">{error}</p>}
      </section>

      {result && (
        <section className="card" style={{ marginTop: 16, maxWidth: 560 }}>
          <h3>Token launched 🎉</h3>
          <p className="addr">Token: <a href={`${EXPLORER}/address/${result.token}`} target="_blank" rel="noreferrer">{result.token}</a></p>
          <p className="addr">Curve: <a href={`${EXPLORER}/address/${result.curve}`} target="_blank" rel="noreferrer">{result.curve}</a></p>
          <p className="addr">Tx: <a href={`${EXPLORER}/tx/${result.hash}`} target="_blank" rel="noreferrer">{short(result.hash)}</a></p>
        </section>
      )}
    </main>
  );
}
