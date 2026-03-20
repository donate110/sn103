import { describe, it, expect, vi, beforeEach } from "vitest";

// We test the SCALE decoding and IP conversion directly by importing internals.
// The module uses process.env so we mock fetch for the integration test.
import { hexToBytes } from "../scale";

// Real testnet response captured from SN103 (14 neurons)
const TESTNET_FIXTURE =
  "0x388a90be061598f4b592afbd546bcb6beadb3c02f5c129df2e11b698f9543dbd412aa58acc7df6cea78de0928a5c6c2e79f3d24e5893d6a5971738cfbc03ca8f33009d01000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000042aa58acc7df6cea78de0928a5c6c2e79f3d24e5893d6a5971738cfbc03ca8f33078a613f3302000000000000009235f10001feff0300da507701de58f8ba575d4a257cac9a521351bcab4eb79f53cd80a8ad911a7556da507701de58f8ba575d4a257cac9a521351bcab4eb79f53cd80a8ad911a7556049d0100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004da507701de58f8ba575d4a257cac9a521351bcab4eb79f53cd80a8ad911a75560fe62c2c3d5699040007b9d7cd8b09feff0300feff03000000005609de0001feff03002ae6c15e8b783eb4684dc05b38ee8e340a29621508db5effbc0ca002d3d4fe15561f27ebc7127d30920a82cce918a934cec54dc3daadd247c4918f218b9b2270089d0100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004561f27ebc7127d30920a82cce918a934cec54dc3daadd247c4918f218b9b22700000000000000000be1b2f0100feff0300eae8397125d6cb456cd3d495cf5d6b37e5545d1881cf47982811f4a67712e814b62041c0a1273650f8c6ec54d22ef75189da3dbccd580155fa2443001dcf88230c9d0100961f50000000000040548900b41f3dc2000000000000000000000000cb17040400000000000000000000000000000000000000000000000000000000000000000004b62041c0a1273650f8c6ec54d22ef75189da3dbccd580155fa2443001dcf882300000000000000002a0c400100feff03008caccc9867918f543a2836b04f5da2160701df0c15f3fe7fac3441f70a90d95232e077f42c5e27f7c3cdadb3ca1694b9895a7f441e2fda175de395a8d30da30b109d010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000432e077f42c5e27f7c3cdadb3ca1694b9895a7f441e2fda175de395a8d30da30b0000000000000000e619410100feff030016ce6d9d45bb6317b04bb2b070c2189f6cfc70c5b16b930a44275228e933582032e077f42c5e27f7c3cdadb3ca1694b9895a7f441e2fda175de395a8d30da30b149d010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000432e077f42c5e27f7c3cdadb3ca1694b9895a7f441e2fda175de395a8d30da30b0000000000000000ea19410100feff0300b847c6bf68139d2739e7d728ed44d9943d43a5067c2d7fd7f6226d2ce1bc6d6c32e077f42c5e27f7c3cdadb3ca1694b9895a7f441e2fda175de395a8d30da30b189d010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000432e077f42c5e27f7c3cdadb3ca1694b9895a7f441e2fda175de395a8d30da30b0000000000000000ee19410100feff030082c6158fd53086591d8ea5072a9cedd9619d61d6eb9964984eb4b014c3147f35cc322b74392f9fceabf97de37e7a7a9c5a4245017a5491f27442f0deefab80001c9d01008601510000000000507b890085e082490000000000000000000000009b1f040400000000000000000000000000000000000000000000000000000000000000000004cc322b74392f9fceabf97de37e7a7a9c5a4245017a5491f27442f0deefab800000000000000000000203440100feff03001e738b33dfbd68eaba7db3f03fe942cfa4e32b728e52c26743b16dbca15af4649e51e2ae2ef754202057c705d83bd3dec7ccac3d65962a0bfc87dd68acbe1362209d01010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000049e51e2ae2ef754202057c705d83bd3dec7ccac3d65962a0bfc87dd68acbe13620bd9eee0a903bf0007b9d7cd8b09000000feff0300feff0300b6648d0101feff030062e1e1a127701a940a0b3308edb20e2440775619a552e8ceb51fc0966e321b76ea9c3547936d1dea36ddf83a7acd1a1a9f518fc62cd45bfcf3abaa13ffbeb77b249d0100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004ea9c3547936d1dea36ddf83a7acd1a1a9f518fc62cd45bfcf3abaa13ffbeb77b000000000000000082ba4d0100feff030026b0796dd76c7e123754248c9382737f29c35d43a9022cbd13cb8d8a91c4a300ea9c3547936d1dea36ddf83a7acd1a1a9f518fc62cd45bfcf3abaa13ffbeb77b289d0100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004ea9c3547936d1dea36ddf83a7acd1a1a9f518fc62cd45bfcf3abaa13ffbeb77b00000000000000008eba4d0100feff0300644bcce82f5473123df46a95c801efbf19f6417e9756606eef9ebcb1636c3b70ea9c3547936d1dea36ddf83a7acd1a1a9f518fc62cd45bfcf3abaa13ffbeb77b2c9d0100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004ea9c3547936d1dea36ddf83a7acd1a1a9f518fc62cd45bfcf3abaa13ffbeb77b00000000000000009aba4d0100feff03007ec3bfeb97cf38b3cb3f4b7e0d6798cfba4404657a8816c7bc072eb960476a20e2f5c8335930b7646ff794166efafb035af4ba1691f3e943706cd91f82d8a26a309d0101000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004e2f5c8335930b7646ff794166efafb035af4ba1691f3e943706cd91f82d8a26a0000000000000000c6ae8d0100feff0300e6d4e29f9575bc78afc13cbf590237bfcd2bd03a63bdb6b23bd59ee1444e182da64544cbce1d0a480e705de0164af5fe137f5e4af923a43b3d223c341a32e524349d0100de4f630000000000689a9800cafffa2d000000000000000000000000e620040400000000000000000000000000000000000000000000000000000000000000000004a64544cbce1d0a480e705de0164af5fe137f5e4af923a43b3d223c341a32e52400000000000000007a3e8d0100feff0300";

// Dynamically import to avoid process.env issues at module level
async function loadModule() {
  // Reset module cache to pick up clean state
  vi.resetModules();
  return import("../bt-metagraph");
}

describe("bt-metagraph", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("SCALE decoding of real testnet data", () => {
    it("decodes 14 neurons from SN103 testnet fixture", async () => {
      // Mock fetch to return the fixture
      const mockFetch = vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            jsonrpc: "2.0",
            id: 1,
            result: TESTNET_FIXTURE,
          }),
      });
      vi.stubGlobal("fetch", mockFetch);
      process.env.BT_NETWORK = "test";
      process.env.BT_NETUID = "103";
      delete process.env.VALIDATOR_URL;
      delete process.env.NEXT_PUBLIC_VALIDATOR_URL;
      delete process.env.MINER_URL;
      delete process.env.NEXT_PUBLIC_MINER_URL;

      const mod = await loadModule();
      const snapshot = await mod.discoverMetagraph();

      expect(snapshot.nodes.length).toBe(14);

      // Verify specific neurons against ground truth from btcli
      const uid0 = snapshot.nodes.find((n) => n.uid === 0)!;
      expect(uid0.isValidator).toBe(true);
      expect(uid0.ip).toBe("0.0.0.0");

      const uid1 = snapshot.nodes.find((n) => n.uid === 1)!;
      expect(uid1.isValidator).toBe(true);

      const uid3 = snapshot.nodes.find((n) => n.uid === 3)!;
      expect(uid3.ip).toBe("194.61.31.180");
      expect(uid3.port).toBe(6091);
      expect(uid3.isValidator).toBe(false);

      const uid7 = snapshot.nodes.find((n) => n.uid === 7)!;
      expect(uid7.ip).toBe("73.130.224.133");
      expect(uid7.port).toBe(8091);

      const uid8 = snapshot.nodes.find((n) => n.uid === 8)!;
      expect(uid8.isValidator).toBe(true);

      const uid13 = snapshot.nodes.find((n) => n.uid === 13)!;
      expect(uid13.ip).toBe("45.250.255.202");
      expect(uid13.port).toBe(8422);
      expect(uid13.isValidator).toBe(false);
    });
  });

  describe("discoverValidatorUrl", () => {
    it("returns null when no validators have public IPs", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            jsonrpc: "2.0",
            id: 1,
            result: TESTNET_FIXTURE,
          }),
      });
      vi.stubGlobal("fetch", mockFetch);
      process.env.BT_NETWORK = "test";
      process.env.BT_NETUID = "103";
      delete process.env.VALIDATOR_URL;
      delete process.env.NEXT_PUBLIC_VALIDATOR_URL;

      const mod = await loadModule();
      // In the testnet fixture, validators (UIDs 0,1,8) all have 0.0.0.0 — no public IP
      const url = await mod.discoverValidatorUrl();
      expect(url).toBeNull();
    });
  });

  describe("discoverMinerUrl", () => {
    it("returns a miner with public IP", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            jsonrpc: "2.0",
            id: 1,
            result: TESTNET_FIXTURE,
          }),
      });
      vi.stubGlobal("fetch", mockFetch);
      process.env.BT_NETWORK = "test";
      process.env.BT_NETUID = "103";
      delete process.env.MINER_URL;
      delete process.env.NEXT_PUBLIC_MINER_URL;

      const mod = await loadModule();
      const url = await mod.discoverMinerUrl();
      // UID 3 (194.61.31.180:6091) or UID 7 (73.130.224.133:8091) or UID 13 (45.250.255.202:8422)
      expect(url).toBeTruthy();
      expect(url).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/);
    });
  });

  describe("caching", () => {
    it("uses cached snapshot for subsequent calls within TTL", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            jsonrpc: "2.0",
            id: 1,
            result: TESTNET_FIXTURE,
          }),
      });
      vi.stubGlobal("fetch", mockFetch);
      process.env.BT_NETWORK = "test";
      process.env.BT_NETUID = "103";

      const mod = await loadModule();
      await mod.discoverMetagraph();
      const callsAfterFirst = mockFetch.mock.calls.length;
      await mod.discoverMetagraph();
      // Second call should use cache — no additional fetch calls
      expect(mockFetch).toHaveBeenCalledTimes(callsAfterFirst);
    });
  });

  describe("fallback on error", () => {
    it("returns empty snapshot when RPC fails and no cache", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("network error"));
      vi.stubGlobal("fetch", mockFetch);
      process.env.BT_NETWORK = "test";

      const mod = await loadModule();
      const snapshot = await mod.discoverMetagraph();
      expect(snapshot.nodes).toEqual([]);
    });
  });
});
