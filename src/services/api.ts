/**
 * Demo API facade.
 *
 * OpenCharts runs without a backend: all real data the terminal needs is served
 * by the in-browser demo layer (services/demo). `api` is the demo implementation
 * wrapped in a Proxy whose fallback returns a benign async no-op for any method
 * not implemented in demo mode — so leftover calls from non-terminal code resolve
 * harmlessly instead of throwing network errors.
 */
import { demoApi } from "./demo/api.ts";

export const API_BASE = "";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// react-query rejects `undefined` query results, so resolve to null instead.
const benign = () => Promise.resolve(null);

export const api = new Proxy({} as Record<string, unknown>, {
  get(_target, prop: string | symbol) {
    if (typeof prop === "symbol" || prop === "then") return undefined;
    const target = demoApi as Record<string, unknown>;
    if (prop in target) return target[prop];
    return benign;
  },
  set(_target, prop: string | symbol, value: unknown) {
    (demoApi as Record<string | symbol, unknown>)[prop] = value;
    return true;
  },
  has(_target, prop: string | symbol) {
    return prop in (demoApi as Record<string, unknown>);
  },
  ownKeys() {
    return Reflect.ownKeys(demoApi as Record<string, unknown>);
  },
  getOwnPropertyDescriptor(_target, prop: string | symbol) {
    const desc = Object.getOwnPropertyDescriptor(demoApi, prop);
    return desc ? { ...desc, configurable: true } : undefined;
  },
  defineProperty(_target, prop: string | symbol, descriptor: PropertyDescriptor) {
    return Reflect.defineProperty(demoApi, prop, descriptor);
  },
  deleteProperty(_target, prop: string | symbol) {
    return Reflect.deleteProperty(demoApi, prop);
  },
}) as typeof demoApi & Record<string, (...args: never[]) => Promise<unknown>>;
