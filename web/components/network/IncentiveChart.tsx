"use client";

import { useMemo } from "react";
import { Bar } from "react-chartjs-2";
import { useRouter } from "next/navigation";
import {
  IP_CLUSTER_COLORS,
  UNIQUE_IP_COLOR,
  GHOST_IP_COLOR,
  baseBarOpts,
} from "./ChartConfig";
import type { ChartOptions } from "chart.js";

export interface MinerDatum {
  uid: number;
  ip: string;
  incentive: number;
  emission: string;
}

interface IncentiveChartProps {
  miners: MinerDatum[];
  ipClusters: Record<string, number[]>;
  metric: "incentive" | "emission";
  showAll: boolean;
}

export default function IncentiveChart({
  miners,
  ipClusters,
  metric,
  showAll,
}: IncentiveChartProps) {
  const router = useRouter();

  // Build cluster color map: top clusters by size get distinct colors
  const clusterColorMap = useMemo(() => {
    const entries = Object.entries(ipClusters).sort(
      (a, b) => b[1].length - a[1].length,
    );
    const map: Record<string, string> = {};
    entries.forEach(([subnet, _uids], i) => {
      if (i < IP_CLUSTER_COLORS.length) map[subnet] = IP_CLUSTER_COLORS[i];
    });
    return map;
  }, [ipClusters]);

  // Sort miners by metric, take top N
  const sorted = useMemo(() => {
    const copy = [...miners];
    if (metric === "incentive") {
      copy.sort((a, b) => b.incentive - a.incentive);
    } else {
      copy.sort((a, b) => parseFloat(b.emission) - parseFloat(a.emission));
    }
    return showAll ? copy : copy.slice(0, 50);
  }, [miners, metric, showAll]);

  // Assign colors
  const barColors = useMemo(() => {
    return sorted.map((m) => {
      if (!m.ip || m.ip === "0.0.0.0") return GHOST_IP_COLOR;
      const subnet = m.ip.split(".").slice(0, 3).join(".");
      return clusterColorMap[subnet] ?? UNIQUE_IP_COLOR;
    });
  }, [sorted, clusterColorMap]);

  // Chart data
  const getValue = (m: MinerDatum) => {
    if (metric === "incentive") return (m.incentive / 65535) * 100;
    return parseFloat(m.emission) / 1e9;
  };

  const data = {
    labels: sorted.map((m) => String(m.uid)),
    datasets: [
      {
        data: sorted.map(getValue),
        backgroundColor: barColors,
        borderWidth: 0,
        borderRadius: 2,
      },
    ],
  };

  const opts: ChartOptions<"bar"> = {
    ...baseBarOpts,
    onClick: (_event, elements) => {
      if (elements.length > 0) {
        const idx = elements[0].index;
        router.push(`/network/miner/${sorted[idx].uid}`);
      }
    },
    plugins: {
      ...baseBarOpts.plugins,
      tooltip: {
        backgroundColor: "rgb(15, 23, 42)", // slate-900
        titleFont: { size: 12 },
        bodyFont: { size: 11 },
        padding: 10,
        cornerRadius: 8,
        callbacks: {
          title: (items) => {
            const idx = items[0].dataIndex;
            const m = sorted[idx];
            return `UID ${m.uid}`;
          },
          afterTitle: (items) => {
            const idx = items[0].dataIndex;
            const m = sorted[idx];
            const subnet = m.ip?.split(".").slice(0, 3).join(".") ?? "none";
            return `IP: ${m.ip}\nCluster: ${subnet}.0/24`;
          },
          label: (item) => {
            if (metric === "incentive") return `Incentive: ${item.formattedValue}%`;
            return `Emission: ${item.formattedValue} TAO`;
          },
        },
      },
    },
    scales: {
      ...baseBarOpts.scales,
      y: {
        ...baseBarOpts.scales?.y,
        title: {
          display: true,
          text: metric === "incentive" ? "Incentive %" : "Emission (TAO)",
          font: { size: 11 },
        },
      },
    },
  };

  // Build legend entries for top clusters
  const legendItems = useMemo(() => {
    const entries = Object.entries(ipClusters)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 10);
    const items = entries
      .filter(([subnet]) => clusterColorMap[subnet])
      .map(([subnet, uids]) => ({
        label: `${subnet}.0/24 (${uids.length})`,
        color: clusterColorMap[subnet],
      }));
    items.push({ label: "Unique IP", color: UNIQUE_IP_COLOR });
    items.push({ label: "No IP", color: GHOST_IP_COLOR });
    return items;
  }, [ipClusters, clusterColorMap]);

  return (
    <div>
      <div className="h-80">
        <Bar data={data} options={opts} />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 px-2">
        {legendItems.map((item) => (
          <div key={item.label} className="flex items-center gap-1.5">
            <span
              className="w-2.5 h-2.5 rounded-sm inline-block"
              style={{ backgroundColor: item.color }}
            />
            <span className="text-[10px] text-slate-500">{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
