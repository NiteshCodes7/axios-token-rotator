import axios from "axios";
import MockAdapter from "axios-mock-adapter";
import { createTokenRotator } from "../src";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setup(overrides = {}) {
  const onRefreshFailed = jest.fn();
  const onAfterRefresh = jest.fn();
  const onRefreshSuccess = jest.fn((data: any) => data.accessToken);

  const { api, setAccessToken, getAccessToken } = createTokenRotator({
    baseURL: "http://localhost",
    onRefreshSuccess,
    onAfterRefresh,
    onRefreshFailed,
    ...overrides,
  });

  const mock = new MockAdapter(api);

  return { api, mock, setAccessToken, getAccessToken, onRefreshFailed, onAfterRefresh, onRefreshSuccess };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createTokenRotator", () => {

  describe("request interceptor", () => {
    it("attaches Authorization header when token is set", async () => {
      const { api, mock, setAccessToken } = setup();
      setAccessToken("my-token");

      let capturedHeader: string | undefined;
      mock.onGet("/data").reply((config) => {
        capturedHeader = config.headers?.Authorization;
        return [200, { ok: true }];
      });

      await api.get("/data");
      expect(capturedHeader).toBe("Bearer my-token");
    });

    it("does not attach Authorization header when token is null", async () => {
      const { api, mock } = setup();

      let capturedHeader: string | undefined;
      mock.onGet("/data").reply((config) => {
        capturedHeader = config.headers?.Authorization;
        return [200, {}];
      });

      await api.get("/data");
      expect(capturedHeader).toBeUndefined();
    });

    it("uses custom applyToken when provided", async () => {
      const applyToken = jest.fn((config: any, token: string) => {
        config.headers["X-Auth-Token"] = token;
      });
      const { api, mock, setAccessToken } = setup({ applyToken });
      setAccessToken("custom-token");

      let capturedHeader: string | undefined;
      mock.onGet("/data").reply((config) => {
        capturedHeader = config.headers?.["X-Auth-Token"];
        return [200, {}];
      });

      await api.get("/data");
      expect(applyToken).toHaveBeenCalled();
      expect(capturedHeader).toBe("custom-token");
    });
  });

  describe("401 → refresh → replay", () => {
    it("refreshes and replays the original request on 401", async () => {
      const { api, mock, onRefreshSuccess, onAfterRefresh } = setup();

      mock.onGet("/protected").replyOnce(401).onGet("/protected").reply(200, { secret: true });
      mock.onPost("/api/auth/refresh").reply(200, { accessToken: "new-token" });

      const res = await api.get("/protected");

      expect(onRefreshSuccess).toHaveBeenCalledWith({ accessToken: "new-token" });
      expect(onAfterRefresh).toHaveBeenCalledWith({ accessToken: "new-token" });
      expect(res.data).toEqual({ secret: true });
    });

    it("updates in-memory token after successful refresh", async () => {
      const { api, mock, getAccessToken } = setup();

      mock.onGet("/protected").replyOnce(401).onGet("/protected").reply(200, {});
      mock.onPost("/api/auth/refresh").reply(200, { accessToken: "refreshed-token" });

      await api.get("/protected");
      expect(getAccessToken()).toBe("refreshed-token");
    });

    it("calls onRefreshFailed and clears token when refresh endpoint returns 401", async () => {
      const { api, mock, onRefreshFailed, getAccessToken, setAccessToken } = setup();
      setAccessToken("expired");

      mock.onGet("/protected").reply(401);
      mock.onPost("/api/auth/refresh").reply(401);

      await expect(api.get("/protected")).rejects.toThrow();
      expect(getAccessToken()).toBeNull();
      expect(onRefreshFailed).toHaveBeenCalled();
    });

    it("does not retry more than once per request", async () => {
      const { api, mock } = setup();

      mock.onGet("/protected").reply(401);
      mock.onPost("/api/auth/refresh").reply(200, { accessToken: "t" });
      // After refresh, still returns 401 → should throw, not loop
      mock.onGet("/protected").reply(401);

      await expect(api.get("/protected")).rejects.toMatchObject({
        response: { status: 401 },
      });
    });
  });

  describe("refresh endpoint guard", () => {
    it("does not intercept a 401 from the refresh endpoint itself", async () => {
      const { api, mock, onRefreshFailed } = setup();

      mock.onPost("/api/auth/refresh").reply(401);

      await expect(api.post("/api/auth/refresh")).rejects.toMatchObject({
        response: { status: 401 },
      });
      // onRefreshFailed should NOT be called via the intercept path
      expect(onRefreshFailed).not.toHaveBeenCalled();
    });
  });

  describe("race condition — multiple simultaneous 401s", () => {
    it("fires refresh only once when multiple requests 401 at the same time", async () => {
      const { api, mock } = setup();

      let refreshCallCount = 0;

      mock.onGet("/a").replyOnce(401).onGet("/a").reply(200, { from: "a" });
      mock.onGet("/b").replyOnce(401).onGet("/b").reply(200, { from: "b" });
      mock.onPost("/api/auth/refresh").reply(() => {
        refreshCallCount++;
        return [200, { accessToken: "race-safe-token" }];
      });

      const [resA, resB] = await Promise.all([api.get("/a"), api.get("/b")]);

      expect(refreshCallCount).toBe(1);
      expect(resA.data).toEqual({ from: "a" });
      expect(resB.data).toEqual({ from: "b" });
    });

    it("rejects all queued requests if refresh fails during a race", async () => {
      const { api, mock, onRefreshFailed } = setup();

      mock.onGet("/a").replyOnce(401);
      mock.onGet("/b").replyOnce(401);
      mock.onPost("/api/auth/refresh").reply(401);

      const [a, b] = await Promise.allSettled([api.get("/a"), api.get("/b")]);

      expect(a.status).toBe("rejected");
      expect(b.status).toBe("rejected");
      // onRefreshFailed fires once — from the refresh leader
      expect(onRefreshFailed).toHaveBeenCalledTimes(1);
    });
  });

  describe("non-401 errors", () => {
    it("passes through non-401 errors without refresh", async () => {
      const { api, mock, onRefreshFailed } = setup();

      mock.onGet("/data").reply(500, { error: "Server error" });

      await expect(api.get("/data")).rejects.toMatchObject({
        response: { status: 500 },
      });
      expect(onRefreshFailed).not.toHaveBeenCalled();
    });

    it("passes through 403 errors without refresh", async () => {
      const { api, mock, onRefreshFailed } = setup();

      mock.onGet("/admin").reply(403);

      await expect(api.get("/admin")).rejects.toMatchObject({
        response: { status: 403 },
      });
      expect(onRefreshFailed).not.toHaveBeenCalled();
    });
  });

  describe("custom refreshEndpoint", () => {
    it("respects a custom refresh endpoint path", async () => {
      const { api, mock } = setup({ refreshEndpoint: "/v2/token/refresh" });

      mock.onGet("/secure").replyOnce(401).onGet("/secure").reply(200, { ok: true });
      mock.onPost("/v2/token/refresh").reply(200, { accessToken: "v2-token" });

      const res = await api.get("/secure");
      expect(res.data).toEqual({ ok: true });
    });
  });

  describe("factory — bring your own axios instance", () => {
    it("attaches interceptors to an existing axios instance", async () => {
      const existing = axios.create({ baseURL: "http://localhost" });
      const mock = new MockAdapter(existing);

      const { api, setAccessToken } = createTokenRotator({
        axiosInstance: existing,
        onRefreshSuccess: (d: any) => d.accessToken,
      });

      setAccessToken("injected-token");
      let captured: string | undefined;
      mock.onGet("/check").reply((config) => {
        captured = config.headers?.Authorization;
        return [200, {}];
      });

      await api.get("/check");
      expect(captured).toBe("Bearer injected-token");
      expect(api).toBe(existing);
    });
  });
});