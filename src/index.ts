import axios, {
  AxiosInstance,
  AxiosRequestConfig,
  InternalAxiosRequestConfig,
} from "axios";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TokenRotatorOptions<TRefreshData = unknown> {
  /**
   * The axios instance to attach interceptors to.
   * If omitted, a new instance is created and returned.
   */
  axiosInstance?: AxiosInstance;

  /**
   * Base URL for all requests.
   */
  baseURL?: string;

  /**
   * The endpoint used to refresh the access token.
   * @default "/api/auth/refresh"
   */
  refreshEndpoint?: string;

  /**
   * Called to attach the token to the outgoing request config.
   * Override this to customize the Authorization scheme.
   * @default sets `config.headers.Authorization = \`Bearer \${token}\``
   */
  applyToken?: (config: InternalAxiosRequestConfig, token: string) => void;

  /**
   * Called with the raw refresh response data.
   * Must return the new access token string.
   */
  onRefreshSuccess: (data: TRefreshData) => string | Promise<string>;

  /**
   * Called with the raw refresh response data after a successful refresh.
   * Use this to store tokens, update sockets, update other state, etc.
   */
  onAfterRefresh?: (data: TRefreshData) => void | Promise<void>;

  /**
   * Called when a refresh attempt fails (e.g. refresh token expired).
   * Use this to clear state and redirect to login.
   */
  onRefreshFailed?: (error: unknown) => void;

  /**
   * Extra config applied to the created axios instance.
   * Ignored if `axiosInstance` is provided.
   */
  axiosConfig?: AxiosRequestConfig;
}

export interface TokenRotatorInstance {
  /** The axios instance with interceptors attached. */
  api: AxiosInstance;
  /** Set the in-memory access token. */
  setAccessToken: (token: string | null) => void;
  /** Read the in-memory access token. */
  getAccessToken: () => string | null;
}

// ─── Internal augmentation ────────────────────────────────────────────────────

interface RetryableRequestConfig extends InternalAxiosRequestConfig {
  _retry?: boolean;
  _queued?: boolean;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates an axios instance (or attaches to an existing one) with automatic
 * token rotation on 401 responses.
 *
 * Race-condition safe: if multiple requests fail with 401 simultaneously,
 * only one refresh call is made; all others queue and replay after it resolves.
 */
export function createTokenRotator<TRefreshData = unknown> (
  options: TokenRotatorOptions<TRefreshData>
): TokenRotatorInstance {
  const {
    axiosInstance,
    baseURL,
    refreshEndpoint = "/api/auth/refresh",
    applyToken,
    onRefreshSuccess,
    onAfterRefresh,
    onRefreshFailed,
    axiosConfig = {},
  } = options;

  // ── In-memory token store ──────────────────────────────────────────────────
  let accessToken: string | null = null;

  function setAccessToken(token: string | null) {
    accessToken = token;
  }

  function getAccessToken(): string | null {
    return accessToken;
  }

  // ── Axios instance ─────────────────────────────────────────────────────────
  const api: AxiosInstance =
    axiosInstance ??
    axios.create({
      baseURL,
      withCredentials: true,
      ...axiosConfig,
    });

  // ── Race-condition guard ───────────────────────────────────────────────────
  // If a refresh is already in-flight, queue subsequent 401s and
  // replay them all once the single refresh resolves/rejects.
  let isRefreshing = false;
  let refreshQueue: Array<{
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    config: RetryableRequestConfig;
  }> = [];

  function processQueue(error: unknown, token: string | null) {
    refreshQueue.forEach(({ resolve, reject, config }) => {
      if (error) {
        reject(error);
      } else {
        if (token && config.headers) {
          applyToken
            ? applyToken(config, token)
            : (config.headers.Authorization = `Bearer ${token}`);
        }
        resolve(api(config));
      }
    });
    refreshQueue = [];
  }

  // ── Request interceptor ───────────────────────────────────────────────────
  api.interceptors.request.use((config) => {
    if (accessToken) {
      applyToken
        ? applyToken(config, accessToken)
        : (config.headers.Authorization = `Bearer ${accessToken}`);
    }
    return config;
  });

  // ── Response interceptor ──────────────────────────────────────────────────
  api.interceptors.response.use(
    (res) => res,
    async (err) => {
      const originalRequest = err.config as RetryableRequestConfig;

      // Don't intercept the refresh call itself — prevents infinite loops.
      // Clear the token but do NOT call onRefreshFailed here; the catch block
      // of the caller (who posted to the refresh endpoint) handles that path.
      if (originalRequest?.url?.includes(refreshEndpoint)) {
        setAccessToken(null);
        return Promise.reject(err);
      }

      if (err.response?.status !== 401 || originalRequest._retry) {
        return Promise.reject(err);
      }

      // Mark so a replayed request doesn't trigger this block again.
      // _retry = "queued" means "I was queued during someone else's refresh"
      // and should not trigger onRefreshFailed if it ultimately fails.
      originalRequest._retry = true;

      // If a refresh is already running, queue this request
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          refreshQueue.push({ resolve, reject, config: originalRequest });
        });
      }

      isRefreshing = true;

      try {
        const { data } = await api.post(refreshEndpoint);

        const newToken = await onRefreshSuccess(data);
        setAccessToken(newToken);

        await onAfterRefresh?.(data);

        // Apply new token to the original request and replay queue
        if (originalRequest.headers) {
          applyToken
            ? applyToken(originalRequest, newToken)
            : (originalRequest.headers.Authorization = `Bearer ${newToken}`);
        }

        processQueue(null, newToken);

        return api(originalRequest);
      } catch (refreshError) {
        setAccessToken(null);
        processQueue(refreshError, null);
        onRefreshFailed?.(refreshError);
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }
  );

  return { api, setAccessToken, getAccessToken };
}