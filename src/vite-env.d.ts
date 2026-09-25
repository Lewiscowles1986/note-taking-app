/// <reference types="vite/client" />

/**
 * The revision this bundle was built from — a git tag when the deploy is a
 * release, otherwise the commit SHA. Injected by vite.config.ts `define`
 * (source: the Pages workflow's VITE_DEPLOYED_REF; "main" in local dev).
 * Used to pin documentation links to the deployed software's revision.
 */
declare const __DEPLOYED_REF__: string;
