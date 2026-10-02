import { useEffect, useState } from "react";
import { AgentUsage } from "./AgentUsage";
import type { UsageData } from "./usage";

// Prefers your own data (`npm run collect`), falls back to the committed sample.
export default function App() {
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = (url: string) => fetch(url).then((r) => (r.ok ? (r.json() as Promise<UsageData>) : Promise.reject(r.status)));
    load("/usage.json")
      .catch(() => load("/usage.sample.json"))
      .then(setData)
      .catch(() => setError("usage.json을 찾을 수 없어요. `npm run collect`를 먼저 실행하세요."));
  }, []);

  if (error) return <p style={{ padding: 24 }}>{error}</p>;
  if (!data) return null;
  return <AgentUsage data={data} />;
}
