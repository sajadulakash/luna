/**
 * The single environment variable, read in exactly one place.
 *
 * An empty value means same-origin requests. In development Vite proxies those
 * /api calls to FastAPI, keeping the browser on HTTPS while Uvicorn uses HTTP.
 */
const raw = import.meta.env.VITE_API_BASE_URL?.trim() ?? '';

/** Base URL with any trailing slash removed, so `${API_BASE_URL}/api/x` is safe. */
export const API_BASE_URL: string = raw.replace(/\/+$/, '');
