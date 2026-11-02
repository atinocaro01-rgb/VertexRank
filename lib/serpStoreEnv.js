// Builds the rank-history store from the environment (kept out of the route files so they never read process.env themselves).
import { createStore } from "./serpStore.js";
export const serpStoreFromEnv = (env = process.env, fetchImpl) => createStore({ env, fetchImpl });
