# axios-token-rotator

[![npm version](https://img.shields.io/npm/v/axios-token-rotator?style=flat-square)](https://www.npmjs.com/package/axios-token-rotator)
[![npm downloads](https://img.shields.io/npm/dm/axios-token-rotator?style=flat-square)](https://www.npmjs.com/package/axios-token-rotator)
[![bundle size](https://img.shields.io/bundlephobia/minzip/axios-token-rotator?style=flat-square)](https://bundlephobia.com/package/axios-token-rotator)
[![license](https://img.shields.io/npm/l/axios-token-rotator?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-blue?style=flat-square)](https://www.typescriptlang.org/)

Automatic JWT / access-token rotation for [axios](https://axios-http.com/) — with **race-condition safety**, a **queue-based replay system**, and zero lock-in.

---

## The problem

When an access token expires, multiple in-flight requests can all receive a `401` simultaneously. Without coordination, each one independently tries to refresh — causing **multiple refresh calls**, **race conditions**, and **inconsistent auth state**.

Most hand-rolled interceptors also hardcode app-specific logic (localStorage, socket updates, redirect URLs) making them impossible to reuse.

`axios-token-rotator` solves both problems.

---

## How the race-condition guard works

```
Request A ──► 401 ──► starts refresh ──────────────────────► replays A ✓
Request B ──► 401 ──► queued ──────────► refresh resolves ──► replays B ✓
Request C ──► 401 ──► queued ──────────► refresh resolves ──► replays C ✓
                            │
                      only ONE POST /refresh
                      fired for all three
```

Without this, `A`, `B`, and `C` would all call `/refresh` independently, potentially invalidating each other's tokens mid-flight.

---

## Features

- 🔄 **Automatic token refresh** on `401` responses
- 🔒 **Race-condition safe** — only one refresh fires at a time; all others queue
- ♻️ **Automatic request replay** — original requests retry transparently after refresh
- 🪝 **Lifecycle hooks** — `onRefreshSuccess`, `onAfterRefresh`, `onRefreshFailed`
- 🔷 **Generic type support** — pass your refresh response type for full type safety
- 🔌 **Bring your own axios instance** — attach to an existing instance
- 🎯 **Framework-agnostic** — no Next.js, React, or socket assumptions
- 🔧 **Customisable auth scheme** — override how the token is applied
- 📦 **Tiny** — zero runtime dependencies beyond axios peer dep

---

## Install

```bash
npm install axios-token-rotator
# or
yarn add axios-token-rotator
# or
pnpm add axios-token-rotator
```

> **Peer dependency:** `axios >= 1.0.0`

---

## Quick start

```ts
import { createTokenRotator } from "axios-token-rotator";

const { api, setAccessToken } = createTokenRotator({
  baseURL: "https://api.example.com",

  // Return the new access token from the refresh response
  onRefreshSuccess: (data) => data.accessToken,

  // Called when refresh fails — clear state and redirect
  onRefreshFailed: () => {
    window.location.href = "/login";
  },
});

// Call after login
setAccessToken(loginResponse.accessToken);

// Use `api` exactly like any axios instance
const { data } = await api.get("/users/me");
```

---

## Type-safe refresh response

Pass your refresh response interface as a generic to get **full type safety** on `onRefreshSuccess` and `onAfterRefresh` — no `any`, no casting:

```ts
import { createTokenRotator } from "axios-token-rotator";

interface RefreshResponse {
  accessToken: string;
  wsToken: string;
}

const { api, setAccessToken } = createTokenRotator<RefreshResponse>({
  baseURL: "https://api.example.com",

  onRefreshSuccess: (data) => data.accessToken,  // ✅ data is RefreshResponse
  onAfterRefresh:   (data) => {                  // ✅ data is RefreshResponse
    localStorage.setItem("wsToken", data.wsToken);
  },

  onRefreshFailed: () => {
    window.location.href = "/login";
  },
});
```

Without the generic, `data` defaults to `unknown` — TypeScript will error if you access properties directly. The generic removes that friction entirely.

---

## Migration from a hand-rolled interceptor

If you had something like this:

```ts
// ❌ Before — app-specific, not reusable, no race-condition safety
api.interceptors.response.use(res => res, async (err) => {
  if (err.response?.status === 401 && !err.config._retry) {
    err.config._retry = true;
    const { data } = await api.post("/api/auth/refresh");
    setAccessToken(data.accessToken);
    localStorage.setItem("wsToken", data.wsToken);  // hardcoded
    updateAllSocketAuth(data.wsToken);              // hardcoded
    return api(err.config);
  }
  window.location.href = "/auth/login";            // hardcoded
});
```

Replace it with:

```ts
// ✅ After — typed, portable, race-condition safe
interface RefreshResponse {
  accessToken: string;
  wsToken: string;
}

const { api, setAccessToken } = createTokenRotator<RefreshResponse>({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001",

  onRefreshSuccess: (data) => data.accessToken,

  onAfterRefresh: (data) => {
    localStorage.setItem("wsToken", data.wsToken);
    updateAllSocketAuth(data.wsToken);
  },

  onRefreshFailed: () => {
    setAccessToken(null);
    localStorage.setItem("wsToken", "");
    window.location.href = "/auth/login";
  },
});

api.defaults.headers.common["X-Requested-With"] = "XMLHttpRequest";
```

---

## API

### `createTokenRotator<TRefreshData>(options)`

Returns `{ api, setAccessToken, getAccessToken }`.

`TRefreshData` defaults to `unknown` if omitted — pass your refresh response interface for full type safety.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `baseURL` | `string` | — | Base URL for the created axios instance |
| `axiosInstance` | `AxiosInstance` | — | Attach to an existing instance instead of creating one |
| `refreshEndpoint` | `string` | `"/api/auth/refresh"` | Endpoint called to refresh the token |
| `onRefreshSuccess` | `(data: TRefreshData) => string \| Promise<string>` | **required** | Return the new access token from the refresh response |
| `onAfterRefresh` | `(data: TRefreshData) => void \| Promise<void>` | — | Side effects after a successful refresh (sockets, storage, etc.) |
| `onRefreshFailed` | `(error: unknown) => void` | — | Called when refresh fails — redirect to login, clear state, etc. |
| `applyToken` | `(config, token) => void` | `Authorization: Bearer <token>` | Override to use a different auth scheme |
| `axiosConfig` | `AxiosRequestConfig` | `{}` | Extra config for the created instance (ignored if `axiosInstance` provided) |

#### Return value

| Property | Type | Description |
|---|---|---|
| `api` | `AxiosInstance` | The axios instance with interceptors attached |
| `setAccessToken` | `(token: string \| null) => void` | Set the in-memory token (call after login) |
| `getAccessToken` | `() => string \| null` | Read the current in-memory token |

---

## Advanced examples

### Custom auth header scheme

```ts
createTokenRotator({
  baseURL: "https://api.example.com",
  onRefreshSuccess: (data) => data.token,
  applyToken: (config, token) => {
    config.headers["X-Auth-Token"] = token;
  },
});
```

### Custom refresh endpoint

```ts
createTokenRotator({
  baseURL: "https://api.example.com",
  refreshEndpoint: "/v2/token/refresh",
  onRefreshSuccess: (data) => data.token,
});
```

### Attach to an existing axios instance

```ts
import axios from "axios";
import { createTokenRotator } from "axios-token-rotator";

const myAxios = axios.create({ baseURL: "https://api.example.com" });

const { api, setAccessToken } = createTokenRotator({
  axiosInstance: myAxios,
  onRefreshSuccess: (data) => data.accessToken,
});

// api === myAxios — same reference, interceptors attached in-place
```

### With Next.js + WebSockets

```ts
// lib/api.ts
import { createTokenRotator } from "axios-token-rotator";
import { updateAllSocketAuth } from "./socketManager";

interface RefreshResponse {
  accessToken: string;
  wsToken: string;
}

export const { api, setAccessToken, getAccessToken } = createTokenRotator<RefreshResponse>({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001",
  axiosConfig: { withCredentials: true },

  onRefreshSuccess: (data) => data.accessToken,

  onAfterRefresh: (data) => {
    localStorage.setItem("wsToken", data.wsToken);
    updateAllSocketAuth(data.wsToken);
  },

  onRefreshFailed: () => {
    setAccessToken(null);
    localStorage.setItem("wsToken", "");
    window.location.href = "/auth/login";
  },
});

api.defaults.headers.common["X-Requested-With"] = "XMLHttpRequest";
```

### Limit setAccessToken exposure (recommended)

```ts
// lib/api.ts
const { api, setAccessToken, getAccessToken } = createTokenRotator<RefreshResponse>({ ... });

export { api, getAccessToken };  // setAccessToken NOT exported

export function initSession(token: string) {
  setAccessToken(token);         // only your auth flow can call this
}

export function clearSession() {
  setAccessToken(null);
}
```

---

## Security notes

- ✅ **In-memory storage is the right choice** for access tokens in SPAs — XSS scripts cannot access closure variables, unlike `localStorage`
- ✅ **Refresh tokens belong in `httpOnly` cookies** (set by server) — use `withCredentials: true` to send them automatically
- ✅ **Your server is the real security boundary** — tokens are validated cryptographically server-side regardless of client-side state

---

## Changelog

### 1.1.1
- Added generic type parameter `TRefreshData` to `createTokenRotator` and `TokenRotatorOptions` for full type-safe refresh response handling

### 1.0.0
- Initial release

---

## Contributing

PRs and issues are welcome. Please open an issue first for significant changes.

```bash
npm install
npm test        # 14 tests
npm run build   # CJS + ESM + types via tsup
```

---

## License

MIT © [axios-token-rotator contributors](https://github.com/YOUR_USERNAME/axios-token-rotator/graphs/contributors)