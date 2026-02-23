"use client";

import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  LogarithmicScale,
  PointElement,
  LineElement,
  Filler,
  Title,
  Tooltip,
  Legend,
} from "chart.js";
import { Line } from "react-chartjs-2";
import Image from "next/image";

ChartJS.register(
  CategoryScale,
  LinearScale,
  LogarithmicScale,
  PointElement,
  LineElement,
  Filler,
  Title,
  Tooltip,
  Legend
);

const LABELS = [
  "2025-02-28","2025-03-07","2025-03-14","2025-03-21","2025-03-28","2025-04-04","2025-04-11","2025-04-18","2025-04-25","2025-05-09","2025-05-16","2025-05-23","2025-05-30","2025-06-06","2025-06-13","2025-06-20","2025-06-27","2025-07-04","2025-07-11","2025-07-18","2025-07-25","2025-08-01","2025-08-08","2025-08-15","2025-08-22","2025-08-29","2025-09-05","2025-09-12","2025-09-19","2025-09-26","2025-10-03","2025-10-10","2025-10-17","2025-10-24","2025-10-31","2025-11-07","2025-11-14","2025-11-21","2025-11-28","2025-12-05","2025-12-12","2025-12-19","2025-12-26","2026-01-02","2026-01-09","2026-01-16","2026-01-23","2026-01-30","2026-02-06","2026-02-13","2026-02-20",
];

const D = {
  topdownMcap: [2755037198.21,2423132907.22,2013368460.82,2131516484.76,2301928539.09,1843503909.50,1978939915.93,2136247862.50,3108901732.48,3691110848.35,3818318117.74,4056151418.66,3642168775.99,3114622851.74,3421640155.38,3117332449.37,2836097807.81,3027611873.37,3525557722.92,3997733972.15,3937047402.94,3378302402.54,3546924475.06,3520807190.20,3226097381.60,3220668855.03,3019583477.35,3431950696.81,3475581757.93,2853797456.02,3117948133.56,3320279490.17,3637187628.85,3708376523.86,3973825110.51,3772068847.75,3279499262.31,2946028071.35,2847135392.81,2785552904.76,2850349808.74,2105777151.78,2094208440.25,2204154782.80,2731524487.47,2677855429.99,2290977994.87,2117255714.95,1543790698.89,1492265374.79,1699070131.42],
  topdownFdv: [6894642409.92,6032636143.38,4998513007.56,5280025433.43,5668077182.43,4521413861.00,4846737459.35,5214129526.08,7542999819.05,8858674407.59,9105679256.49,9767194278.74,8765862934.08,7437907121.17,8140790073.75,7388436191.70,6682157270.97,7096399375.91,7883512560.94,8888454615.81,8742931926.32,7418458125.53,7762097559.28,7701742897.35,7061950487.85,7049841482.95,6605630373.56,7511065759.90,7602908115.83,6241686352.08,6833570461.93,7265548798.55,7947361407.17,8121734895.35,8708436090.28,8231726394.06,7175558231.10,6426319577.82,6233065269.73,6095410921.14,6234966096.32,4607643458.23,4582127862.82,4822603791.59,5975117448.12,5859657719.70,5014937348.35,4632213382.11,3378363447.22,3265183876.76,3718250800.75],
  bottomupAll: [2056495339.88,1854955016.53,1537401692.76,1646151102.98,1802245227.75,1510878399.26,1707184214.69,1888895898.38,2757801857.02,3296242198.16,3398023000.59,3672205192.32,3330860358.18,2810443245.93,3109708916.72,2798533003.59,2531281355.13,2686279151.69,2981170096.72,3464500552.90,3379387534.82,2807195730.47,2964538188.49,2959137365.60,2710147268.31,2737029371.14,2584917330.82,2986130195.75,3051082869.84,2526491078.98,2789781397.05,2955566414.45,3247803785.46,3375683080.27,3616662392.37,3420584401.74,3049517972.08,2533448811.17,2699439243.93,2650907212.82,2722479720.18,2045161389.02,2044935351.50,2165662167.77,2710276839.91,2694727003.94,2329989038.06,2169584606.89,1585373688.86,1544758405.79,1797311369.14],
  dynamicMcap: [69980317.83,116805072.14,97207903.57,124846702.17,169133631.88,208148537.18,310720671.20,386577719.33,584479215.92,743841545.63,774454212.90,858037755.58,805200959.99,667400380.14,764148289.89,669743921.93,605988495.95,641633015.67,709737410.63,903519494.38,860335120.54,669756595.76,728088132.44,740076963.07,675426699.07,705797702.22,681673741.53,822008537.73,860499183.93,728108659.11,820862696.16,862184194.81,957974685.95,1035612716.15,1107549071.72,1048822798.04,982064234.80,681869045.49,903540768.64,894670320.40,926033570.28,717586672.05,724712301.31,776152123.92,988699437.71,1006416371.99,885062994.80,834930694.22,611984593.56,603979111.48,725992418.53],
  taoInPools: [2005884266.09,1764298460.32,1455884212.55,1542192637.82,1663265480.58,1343870123.12,1434121688.45,1548207694.39,2249882827.27,2635366744.92,2702312036.70,2891118496.55,2596867010.67,2212092459.94,2424571157.26,2251894011.11,2036685360.13,2198702656.96,2610026090.10,2978802578.80,2939803179.99,2499459844.41,2633467024.54,2627925049.29,2421135791.01,2404649130.68,2255916532.78,2578863447.99,2612713625.78,2153155064.66,2355153550.97,2503450862.86,2737238670.07,2804381355.19,3001466030.53,2730725415.27,2472326813.24,2228298735.58,2170981858.29,2132636220.66,2189710731.29,1614760842.21,1601092034.05,1684963132.91,2087216684.53,2050103891.36,1746865522.96,1622530943.32,1167432232.45,1132372113.82,1292115135.38],
  rootStaked: [1975114336.29,1719398426.67,1412515485.62,1485356059.70,1588250947.02,1265287525.35,1330483065.89,1421511917.49,2053744193.64,2381780561.20,2429247501.21,2585293127.18,2305517169.67,1957749145.52,2130935843.54,1979584422.20,1784794508.11,1921787524.47,2293120809.34,2589949092.58,2551822632.53,2168477168.26,2272465057.63,2257835199.40,2076315933.92,2048847360.82,1909920432.12,2164906474.06,2174772194.87,1781415000.72,1936761156.84,2051844619.19,2228241614.97,2261373880.63,2405473669.36,2150206408.14,1950181158.87,1745951275.14,1688252676.08,1650331209.27,1686321008.28,1233283053.93,1218980117.88,1278095400.52,1575725092.53,1537981166.31,1302942602.68,1206748528.98,862943987.88,834586364.03,943326381.62],
  supplyTao: [8391411.44,8435083.74,8458663.13,8477581.55,8528553.47,8562273.50,8574373.71,8603776.51,8655301.33,8749991.73,8806007.57,8720946.61,8725386.75,8793747.87,8826470.48,8860329.81,8912997.94,8959451.97,9391335.60,9445107.96,9456552.58,9563220.45,9596041.97,9600028.46,9593389.97,9593697.41,9599576.34,9595304.71,9599907.80,9601531.25,9581654.45,9596779.43,9610855.26,9588580.27,9582699.63,9622944.45,9597787.70,9627063.94,9592365.98,9596828.13,9600268.08,9597383.26,9597806.64,9597979.11,9600148.40,9596970.80,9593447.45,9598515.08,9596245.40,9597491.00,9596037.13],
  allSubnetsTao: [6263762.44,6457219.43,6459008.01,6547160.35,6677246.72,7017372.74,7396907.47,7607562.04,7677825.85,7813932.76,7836700.70,7895441.29,7979598.59,7934934.81,8021811.97,7954212.71,7955051.98,7949364.06,7941202.80,8185282.45,8117086.90,7946544.87,8020422.51,8068548.32,8059118.05,8153036.76,8217726.53,8348846.37,8427399.00,8500317.01,8573177.03,8542629.94,8581952.68,8728349.99,8721417.88,8726270.65,8924724.09,8278832.76,9094758.63,9132944.80,9169588.61,9321118.17,9371986.92,9430363.24,9525471.95,9657435.60,9756805.80,9835746.54,9854726.40,9935099.44,10150885.66],
  dynamicTao: [213149.08,406606.08,408394.65,496547.00,626633.36,966759.38,1346294.11,1556948.68,1627212.49,1763319.40,1786087.34,1844827.94,1928985.23,1884321.46,1971198.61,1903599.35,1904438.63,1898750.71,1890589.44,2134669.10,2066473.54,1895931.51,1969809.15,2017934.96,2008504.69,2102423.41,2167113.17,2298233.01,2376785.64,2449703.65,2522563.68,2492016.58,2531339.32,2677736.63,2670804.52,2675657.29,2874110.73,2228219.40,3044145.27,3082331.44,3118975.26,3270504.81,3321373.56,3379749.88,3474858.59,3606822.25,3706192.44,3785133.18,3804113.05,3884486.09,4100272.31],
  taoInPoolsTao: [6109609.04,6141638.05,6116532.74,6133691.17,6162332.30,6241691.97,6213779.00,6235434.20,6263759.84,6247289.28,6232215.21,6216062.33,6221202.37,6245566.25,6254429.10,6400511.96,6400686.31,6506504.69,6952554.14,7037764.93,7061231.55,7075413.23,7124724.61,7165446.42,7199689.62,7162945.70,7171798.07,7210179.51,7216578.88,7244237.18,7237537.81,7235856.45,7232842.34,7251161.14,7237899.66,6966367.80,7235515.54,7281659.88,7314317.60,7347389.90,7375168.47,7359505.57,7337842.53,7337162.11,7335680.14,7347217.84,7314981.91,7355695.22,7256790.83,7282840.81,7297629.80],
  rootTao: [6015888.66,5985338.10,5934329.90,5907637.69,5884406.44,5876710.00,5764732.38,5725164.69,5717702.39,5646148.56,5602459.31,5558521.12,5523228.11,5527459.73,5496966.79,5626532.03,5609069.52,5687044.36,6108385.90,6119053.68,6129325.46,6138475.11,6148050.30,6156338.87,6174304.77,6103086.81,6071839.75,6052807.61,6006940.42,5993526.89,5951791.16,5930555.03,5887875.42,5847131.44,5800691.02,5485402.75,5707403.25,5705439.38,5687940.79,5685745.53,5679700.68,5620865.50,5586614.61,5565458.95,5538004.44,5511858.55,5456059.12,5470758.15,5364083.54,5367634.51,5327734.75],
  buTdRatio: [0.7464,0.7655,0.7636,0.7723,0.7829,0.8196,0.8627,0.8842,0.8871,0.8930,0.8899,0.9053,0.9145,0.9023,0.9088,0.8977,0.8925,0.8873,0.8456,0.8666,0.8584,0.8309,0.8358,0.8405,0.8401,0.8498,0.8561,0.8701,0.8779,0.8853,0.8947,0.8902,0.8929,0.9103,0.9101,0.9068,0.9299,0.8600,0.9481,0.9517,0.9551,0.9712,0.9765,0.9825,0.9922,1.0063,1.0170,1.0247,1.0269,1.0351,1.0578],
  dynamicPct: [2.54,4.82,4.83,5.86,7.35,11.29,15.70,18.10,18.80,20.15,20.28,21.15,22.11,21.43,22.33,21.48,21.37,21.19,20.13,22.60,21.85,19.83,20.53,21.02,20.94,21.91,22.58,23.95,24.76,25.51,26.33,25.97,26.34,27.93,27.87,27.80,29.95,23.15,31.74,32.12,32.49,34.08,34.61,35.21,36.20,37.58,38.63,39.43,39.64,40.47,42.73],
  rootPct: [98.47,97.46,97.02,96.31,95.49,94.15,92.77,91.82,91.28,90.38,89.90,89.42,88.78,88.50,87.89,87.91,87.63,87.41,87.86,86.95,86.80,86.76,86.29,85.92,85.76,85.20,84.66,83.95,83.24,82.74,82.24,81.96,81.40,80.64,80.14,78.74,78.88,78.35,77.76,77.38,77.01,76.38,76.13,75.85,75.49,75.02,74.59,74.37,73.92,73.70,73.01],
  price: [328.32,287.27,238.02,251.43,269.91,215.31,230.80,248.29,359.19,421.84,433.60,465.10,417.42,354.19,387.66,351.83,318.20,337.92,375.41,423.26,416.33,353.26,369.62,366.75,336.28,335.71,314.55,357.67,362.04,297.22,325.41,345.98,378.45,386.75,414.69,391.99,341.69,306.02,296.81,290.26,296.90,219.41,218.20,229.65,284.53,279.03,238.81,220.58,160.87,155.48,177.06],
};

function fmtUsd(v: number) {
  if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(0) + "M";
  return "$" + v.toFixed(0);
}

function fmtTao(v: number) {
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return v.toFixed(0);
}

const LINE_DEFAULTS = { pointRadius: 0, tension: 0.3, fill: false } as const;

export default function TaoValuation() {
  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <Image src="/djinn-logo.png" alt="Djinn" width={40} height={40} className="w-10 h-10" />
        <span className="text-2xl font-bold text-slate-900 font-wordmark tracking-wide">DJINN</span>
      </div>

      <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 mb-1">
        TAO Valuation: Top-Down vs Bottom-Up
      </h1>
      <div className="w-12 h-0.5 bg-gradient-to-r from-idiot-500 to-genius-500 rounded mb-2" />
      <p className="text-sm text-slate-500 mb-8">
        Since dTAO Launch (Feb 2025) &mdash; Weekly Snapshots &mdash; Last Updated Feb 23, 2026
      </p>

      {/* Intro callout */}
      <div className="card !border-l-4 !border-l-idiot-500 mb-8">
        <h2 className="text-lg font-bold text-slate-900 mb-2">What is this page?</h2>
        <p className="text-sm text-slate-500 leading-relaxed mb-2">
          Bittensor ($TAO) is a decentralized network of AI subnets. Each subnet has its own token
          (&ldquo;alpha&rdquo;) priced by an on-chain AMM pool. This creates two independent ways to value
          the network:
        </p>
        <p className="text-sm text-slate-500 leading-relaxed mb-2">
          <strong className="text-slate-900">Top-down:</strong> Take the total TAO in circulation and
          multiply by its market price. This is what CoinGecko shows &mdash; the simple &ldquo;market cap.&rdquo;
        </p>
        <p className="text-sm text-slate-500 leading-relaxed mb-2">
          <strong className="text-slate-900">Bottom-up:</strong> Go subnet by subnet, add up what each one
          is worth, and see if the parts explain the whole. Like valuing a conglomerate by summing its divisions.
        </p>
        <p className="text-sm text-slate-500 leading-relaxed">
          The question is: <strong className="text-slate-900">does the sum of the parts equal the whole?</strong>{" "}
          And how has this relationship changed over the first year of dTAO?
        </p>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {[
          { label: "Top-Down Market Cap", value: "$1.70B", sub: "Supply \u00d7 Price" },
          { label: "Top-Down FDV", value: "$3.72B", sub: "21M \u00d7 Price" },
          { label: "Bottom-Up (All Subnets)", value: "$1.80B", sub: "10,150,886 TAO (incl root)" },
          { label: "Dynamic Subnets MCap", value: "$0.73B", sub: "4,100,272 TAO" },
          { label: "TAO in Pools (Hard Floor)", value: "7,297,630 TAO", sub: "$1,292M" },
          { label: "Root Staked", value: "5,327,735 TAO", sub: "73.0% of total staked" },
          { label: "Bottom-Up / Top-Down", value: "105.8%", sub: "Sum of parts vs whole" },
          { label: "Data Points", value: "51", sub: "2025-02-28 \u2192 2026-02-20" },
        ].map((s) => (
          <div key={s.label} className="card text-center hover:border-idiot-500 transition-colors">
            <div className="text-xs text-slate-500 uppercase tracking-wider">{s.label}</div>
            <div className="text-xl sm:text-2xl font-semibold text-slate-900 mt-1">{s.value}</div>
            <div className="text-[11px] text-slate-400 mt-0.5">{s.sub}</div>
          </div>
        ))}
      </div>

      {/* ==================== CHART 1: USD VALUATIONS ==================== */}
      <div className="mb-4">
        <h3 className="text-lg font-bold text-slate-900 mb-2 border-b border-slate-200 pb-2">
          Chart 1: All Valuations in USD
        </h3>
        <p className="text-sm text-slate-700 leading-relaxed mb-2">
          This chart shows every valuation metric converted to USD on a log scale. The{" "}
          <span className="text-red-400 font-semibold">red line</span> is the top-down market cap (what the
          market says TAO is worth). Everything else is a bottom-up measure.
        </p>
        <p className="text-sm text-slate-700 leading-relaxed mb-2">
          The key thing to notice: at launch in Feb 2025, there was a{" "}
          <span className="text-amber-700 font-semibold">huge gap</span> between the red line (top-down) and
          the <span className="text-cyan-500">cyan line</span> (dynamic subnets). Almost all of TAO&rsquo;s
          value was in root staking (<span className="text-orange-500">orange</span>), not in actual subnets
          doing AI work. Over the year, dynamic subnets grew from{" "}
          <span className="text-emerald-700 font-semibold">$70M to $730M</span> &mdash; a 10x increase &mdash;
          while root shrank.
        </p>
        <p className="text-sm text-slate-700 leading-relaxed">
          The <span className="text-violet-500">purple line</span> (TAO locked in pools) is the &ldquo;hard
          floor&rdquo; &mdash; the actual TAO committed as liquidity backing. It tracks closely to the{" "}
          <span className="text-emerald-700 font-semibold">green line</span> (total bottom-up), confirming that
          most of the bottom-up value is real liquidity, not just paper valuation.
        </p>
      </div>
      <div className="card mb-10">
        <Line
          data={{
            labels: LABELS,
            datasets: [
              { label: "Top-Down Market Cap (USD)", data: D.topdownMcap, borderColor: "#f87171", backgroundColor: "rgba(248,113,113,0.1)", borderWidth: 2.5, ...LINE_DEFAULTS },
              { label: "Top-Down FDV (USD)", data: D.topdownFdv, borderColor: "#fbbf24", borderDash: [5, 5], borderWidth: 1.5, ...LINE_DEFAULTS },
              { label: "Bottom-Up All Subnets (USD)", data: D.bottomupAll, borderColor: "#34d399", backgroundColor: "rgba(52,211,153,0.1)", borderWidth: 2.5, ...LINE_DEFAULTS },
              { label: "Dynamic Subnets MCap (USD)", data: D.dynamicMcap, borderColor: "#22d3ee", borderWidth: 2, ...LINE_DEFAULTS },
              { label: "TAO in Pools - Hard Floor (USD)", data: D.taoInPools, borderColor: "#a78bfa", borderWidth: 2, ...LINE_DEFAULTS },
              { label: "Root Staked (USD)", data: D.rootStaked, borderColor: "#fb923c", borderWidth: 1.5, ...LINE_DEFAULTS },
            ],
          }}
          options={{
            responsive: true,
            plugins: {
              title: { display: true, text: "All Valuations in USD (Log Scale)", color: "#0f172a", font: { size: 16 } },
              legend: { labels: { color: "#64748b", usePointStyle: true, padding: 15 } },
              tooltip: {
                mode: "index" as const,
                intersect: false,
                callbacks: { label: (ctx) => ctx.dataset.label + ": " + fmtUsd(ctx.parsed.y ?? 0) },
              },
            },
            scales: {
              x: { ticks: { color: "#64748b", maxTicksLimit: 12 }, grid: { color: "#e2e8f0" } },
              y: {
                type: "logarithmic" as const,
                ticks: { color: "#94a3b8", callback: (v) => fmtUsd(v as number) },
                grid: { color: "#e2e8f0" },
              },
            },
            interaction: { mode: "nearest" as const, axis: "x" as const, intersect: false },
          }}
        />
      </div>

      {/* ==================== CHART 2: TAO-DENOMINATED ==================== */}
      <div className="mb-4">
        <h3 className="text-lg font-bold text-slate-900 mb-2 border-b border-slate-200 pb-2">
          Chart 2: Everything in TAO (Removes Price Noise)
        </h3>
        <p className="text-sm text-slate-700 leading-relaxed mb-2">
          Chart 1 mixes two signals: TAO price movements and structural capital flows. This chart strips out
          the USD price and shows everything denominated in TAO. Now you can see what&rsquo;s{" "}
          <em>actually</em> happening inside the network.
        </p>
        <p className="text-sm text-slate-700 leading-relaxed mb-2">
          The <span className="text-red-400 font-semibold">red line</span> (circulating supply) is flat at
          ~9.6M TAO &mdash; new emissions roughly match burns. But underneath, a massive reallocation is
          underway:
        </p>
        <p className="text-sm text-slate-700 leading-relaxed mb-2">
          <span className="text-orange-500">Root staked</span> is falling steadily:{" "}
          <span className="text-amber-700 font-semibold">6.0M &rarr; 5.3M TAO</span> (lost 700K TAO, -12%).
          Meanwhile, <span className="text-cyan-500">dynamic subnet market cap</span> is rising:{" "}
          <span className="text-emerald-700 font-semibold">213K &rarr; 4.1M TAO</span> (up 19x). Capital is
          migrating from the &ldquo;savings account&rdquo; (root) into actual subnet bets.
        </p>
        <p className="text-sm text-slate-700 leading-relaxed">
          The <span className="text-emerald-700 font-semibold">green line</span> (all subnets
          mark-to-market including root) has been climbing steadily from 6.3M to 10.2M TAO. This is
          remarkable: it now <strong>exceeds circulating supply</strong>. How is that possible? Because AMM
          pricing creates leverage &mdash; a small amount of TAO in a pool supports a much larger notional
          market cap for the alpha tokens. More on this in Chart 3.
        </p>
      </div>
      <div className="card mb-10">
        <Line
          data={{
            labels: LABELS,
            datasets: [
              { label: "Circulating Supply (TAO)", data: D.supplyTao, borderColor: "#f87171", borderWidth: 2, ...LINE_DEFAULTS },
              { label: "All Subnets Mark-to-Market (TAO)", data: D.allSubnetsTao, borderColor: "#34d399", borderWidth: 2, ...LINE_DEFAULTS },
              { label: "Dynamic Subnets MCap (TAO)", data: D.dynamicTao, borderColor: "#22d3ee", borderWidth: 2, ...LINE_DEFAULTS },
              { label: "Total TAO in Pools (TAO)", data: D.taoInPoolsTao, borderColor: "#a78bfa", borderWidth: 2, ...LINE_DEFAULTS },
              { label: "Root Staked (TAO)", data: D.rootTao, borderColor: "#fb923c", borderWidth: 2, ...LINE_DEFAULTS },
            ],
          }}
          options={{
            responsive: true,
            plugins: {
              title: { display: true, text: "TAO-Denominated Metrics (Price-Neutral View)", color: "#0f172a", font: { size: 16 } },
              legend: { labels: { color: "#64748b", usePointStyle: true, padding: 15 } },
              tooltip: {
                mode: "index" as const,
                intersect: false,
                callbacks: { label: (ctx) => ctx.dataset.label + ": " + fmtTao(ctx.parsed.y ?? 0) },
              },
            },
            scales: {
              x: { ticks: { color: "#64748b", maxTicksLimit: 12 }, grid: { color: "#e2e8f0" } },
              y: {
                ticks: {
                  color: "#64748b",
                  callback: (v) => {
                    const n = v as number;
                    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
                    if (n >= 1e3) return (n / 1e3).toFixed(0) + "K";
                    return String(n);
                  },
                },
                grid: { color: "#e2e8f0" },
              },
            },
            interaction: { mode: "nearest" as const, axis: "x" as const, intersect: false },
          }}
        />
      </div>

      {/* ==================== CHART 3: RATIOS ==================== */}
      <div className="mb-4">
        <h3 className="text-lg font-bold text-slate-900 mb-2 border-b border-slate-200 pb-2">
          Chart 3: The Convergence &mdash; and the Crossover
        </h3>
        <p className="text-sm text-slate-700 leading-relaxed mb-2">
          This is the most important chart. It shows three ratios that tell the story of dTAO&rsquo;s first year.
        </p>
        <p className="text-sm text-slate-700 leading-relaxed mb-2">
          The <span className="text-emerald-700 font-semibold">green line</span> is the ratio of bottom-up to
          top-down valuation &mdash; what fraction of TAO&rsquo;s market cap is explained by the sum of its
          subnets. At dTAO launch, it was <span className="text-amber-700 font-semibold">75%</span>: a quarter
          of TAO&rsquo;s value was just &ldquo;floating&rdquo; in wallets, not committed anywhere. Over the
          year it climbed steadily to{" "}
          <span className="text-emerald-700 font-semibold">100%</span> in Jan 2026 and now sits at{" "}
          <span className="text-emerald-700 font-semibold">106%</span>. The sum of the parts now{" "}
          <em>exceeds</em> the whole.
        </p>
        <p className="text-sm text-slate-700 leading-relaxed mb-2">
          How is BU/TD &gt; 100% possible? Because the AMM creates leverage. When you stake 1 TAO into a subnet
          pool, the resulting alpha tokens can have a notional value greater than 1 TAO (the mark-to-market price
          times total supply exceeds the actual TAO backing). It&rsquo;s similar to how a stock&rsquo;s market
          cap can exceed its book value &mdash; the market is pricing in future earnings (emissions).
        </p>
        <p className="text-sm text-slate-700 leading-relaxed">
          The <span className="text-cyan-500">cyan line</span> shows dynamic subnets as a percentage of total
          supply &mdash; growing from <span className="text-amber-700 font-semibold">2.5% to 43%</span>. This
          is the &ldquo;real economy&rdquo; of Bittensor. The{" "}
          <span className="text-orange-500">orange line</span> shows root&rsquo;s declining share of staked
          TAO: from <span className="text-amber-700 font-semibold">98% to 73%</span>. The network has gone
          from &ldquo;almost everything in savings&rdquo; to &ldquo;nearly half actively invested in subnets.&rdquo;
        </p>
      </div>

      {/* Callout */}
      <div className="card !border-l-4 !border-l-idiot-500 mb-4">
        <p className="text-sm text-slate-500 leading-relaxed">
          <strong className="text-emerald-700">The big picture:</strong> One year ago, Bittensor was
          essentially a single-asset staking network (98% root). Today it&rsquo;s a diversified portfolio of
          128 AI subnets commanding 43% of total value. The &ldquo;conglomerate discount&rdquo; (top-down &gt;
          bottom-up) has turned into a &ldquo;conglomerate premium&rdquo; (bottom-up &gt; top-down), suggesting
          the market is <em>underpricing</em> TAO relative to the value of its constituent subnets.
        </p>
      </div>

      <div className="card mb-10">
        <Line
          data={{
            labels: LABELS,
            datasets: [
              { label: "Bottom-Up / Top-Down Ratio", data: D.buTdRatio, borderColor: "#34d399", borderWidth: 2.5, pointRadius: 1, tension: 0.3, fill: false, yAxisID: "y" },
              { label: "Dynamic Subnets as % of Supply", data: D.dynamicPct, borderColor: "#22d3ee", borderWidth: 2, pointRadius: 1, tension: 0.3, fill: false, yAxisID: "y1" },
              { label: "Root as % of Total Staked", data: D.rootPct, borderColor: "#fb923c", borderWidth: 2, pointRadius: 1, tension: 0.3, fill: false, yAxisID: "y1" },
            ],
          }}
          options={{
            responsive: true,
            plugins: {
              title: { display: true, text: "Valuation Ratios Over Time", color: "#0f172a", font: { size: 16 } },
              legend: { labels: { color: "#64748b", usePointStyle: true, padding: 15 } },
              tooltip: { mode: "index" as const, intersect: false },
            },
            scales: {
              x: { ticks: { color: "#64748b", maxTicksLimit: 12 }, grid: { color: "#e2e8f0" } },
              y: {
                position: "left" as const,
                title: { display: true, text: "BU/TD Ratio", color: "#059669" },
                ticks: { color: "#059669", callback: (v) => ((v as number) * 100).toFixed(0) + "%" },
                grid: { color: "#e2e8f0" },
              },
              y1: {
                position: "right" as const,
                title: { display: true, text: "Percentage", color: "#0891b2" },
                ticks: { color: "#0891b2", callback: (v) => (v as number).toFixed(0) + "%" },
                grid: { drawOnChartArea: false },
              },
            },
            interaction: { mode: "nearest" as const, axis: "x" as const, intersect: false },
          }}
        />
      </div>

      {/* ==================== CHART 4: PRICE CONTEXT ==================== */}
      <div className="mb-4">
        <h3 className="text-lg font-bold text-slate-900 mb-2 border-b border-slate-200 pb-2">
          Chart 4: TAO Price for Context
        </h3>
        <p className="text-sm text-slate-700 leading-relaxed mb-2">
          Everything above happens against a volatile TAO price backdrop. TAO ranged from{" "}
          <span className="text-amber-700 font-semibold">$155 to $465</span> over this period. The halving in
          December 2025 cut daily emissions from 7,200 to 3,600 TAO. Despite the price dropping ~50% from its
          May peak, the structural trend (capital migrating from root to subnets) has been remarkably steady.
        </p>
        <p className="text-sm text-slate-700 leading-relaxed">
          This decoupling between price and structure is the key insight: even as the market goes up and down,
          capital inside Bittensor is consistently flowing <em>toward active subnet investment and away from
          passive root staking</em>. The network is maturing.
        </p>
      </div>
      <div className="card mb-10">
        <Line
          data={{
            labels: LABELS,
            datasets: [
              { label: "TAO Price (USD)", data: D.price, borderColor: "#059669", backgroundColor: "rgba(5,150,105,0.06)", borderWidth: 2, pointRadius: 0, fill: true, tension: 0.3 },
            ],
          }}
          options={{
            responsive: true,
            plugins: {
              title: { display: true, text: "TAO Price (USD)", color: "#0f172a", font: { size: 16 } },
              legend: { labels: { color: "#64748b" } },
            },
            scales: {
              x: { ticks: { color: "#64748b", maxTicksLimit: 12 }, grid: { color: "#e2e8f0" } },
              y: { ticks: { color: "#64748b", callback: (v) => "$" + v }, grid: { color: "#e2e8f0" } },
            },
          }}
        />
      </div>

      {/* Methodology */}
      <div className="text-center text-xs text-slate-400 border-t border-slate-200 pt-5 pb-8">
        <p className="font-semibold mb-2">Methodology &amp; Definitions</p>
        <p className="mb-1">
          <strong>Top-Down Market Cap</strong> = circulating TAO supply &times; USD spot price (from CoinGecko).{" "}
          <strong>FDV</strong> = 21M max supply &times; price.
        </p>
        <p className="mb-1">
          <strong>Bottom-Up All Subnets</strong> = &Sigma;(total_alpha &times; alpha_price_in_TAO) for all 128+
          subnets + root (SN0). Root&rsquo;s alpha is TAO itself (price = 1.0).
        </p>
        <p className="mb-1">
          <strong>Dynamic Subnets MCap</strong> = same as above, excluding root. This is the &ldquo;real
          economy&rdquo; &mdash; actual AI subnet value.
        </p>
        <p className="mb-1">
          <strong>TAO in Pools (Hard Floor)</strong> = &Sigma;(tao_in) across all AMM pools. This is the actual
          TAO locked as liquidity &mdash; the minimum realizable value.
        </p>
        <p className="mb-1">
          <strong>Root Staked</strong> = TAO staked in SN0 (the base-layer &ldquo;savings account&rdquo;).
          Earns no subnet emissions since Dec 2025.
        </p>
        <p className="mb-3">
          Data sources: CoinGecko API (price, market cap) + Taostats API (subnet pool snapshots). Sampled
          weekly since dTAO launch (Feb 13, 2025).
        </p>
        <p className="text-slate-300">
          Built by an autonomous AI treasury agent. Updated Feb 23, 2026.
        </p>
      </div>
    </div>
  );
}
