import { useEffect, useState } from "react";
import { AgentUsage } from "./AgentUsage";
import type { UsageData } from "./usage";

// Prefers your own data (`npm run collect`), falls back to the committed sample.
// `?sample` (or a VITE_DEMO build, used for GitHub Pages) forces the sample — for demos that shouldn't show real usage.
export default function App() {
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = (file: string) =>
      fetch(`${import.meta.env.BASE_URL}${file}`).then((r) => (r.ok ? (r.json() as Promise<UsageData>) : Promise.reject(r.status)));
    const params = new URLSearchParams(location.search);
    const sampleOnly = params.has("sample") || Boolean(import.meta.env.VITE_DEMO);
    const theme = params.get("theme"); // "light" | "dark" — overrides the OS setting
    if (theme) document.documentElement.dataset.theme = theme;
    (sampleOnly ? Promise.reject() : load("usage.json"))
      .catch(() => load("usage.sample.json"))
      .then(setData)
      .catch(() => setError("usage.json을 찾을 수 없어요. `npm run collect`를 먼저 실행하세요."));
  }, []);

  if (error) return <p style={{ padding: 24 }}>{error}</p>;
  if (!data) return null;
  return <AgentUsage data={data} />;
}
