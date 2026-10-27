// MAIN-world content script (document_start): see adapters/codechef/hook.ts.
import { installCodeChefHook, type HookWindow } from "../adapters/codechef/hook.js";

installCodeChefHook(window as unknown as HookWindow);
